const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { defineString } = require('firebase-functions/params');
const axios = require('axios'); // Para chamadas HTTP
const OpenAI = require('openai');

const admin = require('firebase-admin');
admin.initializeApp();

const OPENAI_API_KEY = defineString('OPENAI_API_KEY');
const TWILIO_ACCOUNT_SID = defineString('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineString('TWILIO_AUTH_TOKEN');
const TWILIO_STUDIO_FLOW_SID = defineString('TWILIO_STUDIO_FLOW_SID');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });



const activateStudio = async (to, from, json) => {
    const client = require('twilio')(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());

    client.studio.v2.flows(TWILIO_STUDIO_FLOW_SID.value())
    .executions
    .create({
        to, 
        from,
        parameters: {
            json
        }
    })
    .then(execution => console.log(execution.sid));

}
// Defina suas variáveis de ambiente no Firebase.

exports.identificaLixo = onRequest(async (request, response) => {
    logger.info("Processando requisição", {structuredData: true});
    logger.info('Conteúdo da requisição', request.body);

    const imageUrl = request.body.url; // A URL da imagem enviada via Twilio.
    
    if (!imageUrl) {
        logger.error('Nenhuma URL de imagem fornecida');
        response.status(400).send('Nenhuma URL de imagem fornecida');
        return;
    }

    try {
        // Simulação de análise de imagem pela OpenAI. Substitua isso pela sua implementação real.
        const aiResponse = await analyzeImageWithOpenAI(imageUrl, request.body.from);
        activateStudio(request.body.to, request.body.from, aiResponse);
        response.status(200).send(JSON.stringify(aiResponse));
    } catch (error) {
        logger.error('Erro ao processar a imagem', error);
        response.status(500).send('Erro interno');
    }
});


exports.importaPontosColeta = onRequest(async (request, response) => {
    logger.info('CHAMOU importaPontosColeta!');

    // Ler o arquivo JSON com os dados a serem importados
    const dados = require('./data/pontosColeta.json');
    const promises = [];
    
    dados.forEach(ponto => {
        const promise = admin.firestore().collection('pontosColeta').add(ponto);
        promises.push(promise);
    });

    try {
        await Promise.all(promises);
        response.status(200).send("Dados importados com sucesso para a coleção pontosColeta.");
    } catch (error) {
        console.error("Erro ao importar dados: ", error);
        response.status(500).send("Erro ao importar dados para a coleção pontosColeta.");
    }
});


exports.listaEcopontos = onRequest(async (request, response) => {

    const geofire = require('geofire-common');
    let center = [];
    const radiusInM = 5 * 1000; 

    if (request.body.lat && request.body.lng) {
        center = [ parseFloat(request.body.lat), parseFloat(request.body.lng) ];
        logger.info('listaEcopontos', center);

    } else {
        // TODO: fazer geolocation do texto

    }


    const bounds = geofire.geohashQueryBounds(center, radiusInM);
    logger.info('BOUNDS', bounds);

    const promises = [];
    for (const b of bounds) {
        const q = admin.firestore()
            .collection('pontosColeta')
            .orderBy('geohash')
            .startAt(b[0]).endAt(b[1]);

        // const q = query(
        //     collection(admin.firestore(), 'pontosColeta'), 
        //     orderBy('geohash'), 
        //     startAt(b[0]), 
        //     endAt(b[1]));


        promises.push(q.get());
    }
    
    // Collect all the query results together into a single list
    const snapshots = await Promise.all(promises);
    
    const matchingDocs = [];
    for (const snap of snapshots) {
      for (const doc of snap.docs) {
        const lat = parseFloat(doc.get('latitude'));
        const lng = parseFloat(doc.get('longitude'));
    
        // We have to filter out a few false positives due to GeoHash
        // accuracy, but most will match
        const distanceInKm = geofire.distanceBetween([lat, lng], center);
        const distanceInM = distanceInKm * 1000;

        // logger.info('distanceInKm', distanceInKm);
        if (distanceInM <= radiusInM) {
            let data = doc.data();
            data.distanceInM = distanceInM;
            data.distanceInKm = distanceInKm;
            matchingDocs.push(data);
        }
      }
    }

    // TODO: fazer sort por distanceInM
    const ecopontos = matchingDocs
        .sort((current, next) => current.distanceInM - next.distanceInM);

    if (ecopontos.length > 0) {
        const ecoponto = ecopontos[0]
        // TODO: receber lat long ou endereço
        logger.info('RESULTADO GEOHASH', ecopontos);

        response.contentType('application/json').status(200).send(JSON.stringify({
            mensagem: `Encontrei o seguinte ecoponto próximo de você:\n\n*${ecoponto.nome}*\n\n${ecoponto.endereco}\nCep: ${ecoponto.cep}\n${ecoponto.distanceInM.toFixed(0)} metro(s) de você.\n\nTelefone: ${ecoponto.telefone}\nHorário de Funcionamento: ${ecoponto.horario_funcionamento}.\n\nItens aceitos: ${ecoponto.itens_recebidos.join(', ')}`,
            location: {
                lat: ecoponto.latitude,
                lng: ecoponto.longitude
            },
            nome: ecoponto.nome
        }));

    } else {
        // TODO: receber lat long ou endereço
        logger.info('RESULTADO GEOHASH: SEM ECOPONTO');

        response.contentType('application/json').status(200).send(JSON.stringify({
            mensagem: `Não encontrei nenhum ecoponto em um raio de 5 quilômetros da sua localização.`
        }));
        // response.status(200).send(`Não encontrei nenhum ecoponto em um raio de 5 quilômetros da sua localização.`);

    }

    
});


const getFirestorePrompt = async () => {    
    const settings = await admin.firestore().collection('settings').doc('default').get();
    if (settings.exists) {
        settingsData = await settings.data();
        logger.info('EXISTE', settingsData.promptImagem);
        return settingsData.promptImagem;
    }
    return `Esta é a imagem de um lixo, faça uma análise completa e retorne um arquivo json seguinte formato:
            
    {
        "objeto" : <nome do objeto>,
        "material": <composição aproximada do material>,
        "emoji_material" : <emoji que melhor representa o material>,
        "tipo_de_descarte" : <"reciclavel", "lixo eletrônico", "compostagem", "descarte simples">,
        "condicao_descarte" : <avisos sobre cuidados específicos para que o material possa ser descartado adequadamente">,
        "reuso": <"sim", "não", "talvez">,
        "possibilidades_criativas_de_reuso" : <uma ideia interessante para uso criativo e artistico>
        "justificativa_talvez" :  <explique porque você esta em dúvida>
    }

    Retorne APENAS o conteúdo do JSON de forma textual e nada mais. Deve ser um JSON válido.
    `;
}

async function analyzeImageWithOpenAI(imageUrl,from) {
    const openAIResponse = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: await getFirestorePrompt() },
            {
              type: "image_url",
              image_url: {
                "url": imageUrl,
              },
            },
          ],
        },
      ],
    });
    console.log(openAIResponse)
    let response = openAIResponse.choices[0].message.content.split('```json').join('').split('```').join('')
    // Assumindo que a resposta da OpenAI vem no formato esperado, você pode precisar fazer um parse adicional
    // dependendo de como a informação é formatada na resposta.
    console.log(response);
    try {
      response = JSON.parse(response)
      await admin.firestore().collection('logs').add({
      
        messageResponse: openAIResponse.choices[0].message,
        response: response,
        from,
        imageUrl
        });
      
        // Aqui você retornaria a resposta processada conforme necessário para seu uso.
        // Isso pode envolver converter a string JSON em um objeto JavaScript para facilitar o manuseio.
        
  }
    catch (error)
    {
      response = { "mensagem" : openAIResponse.choices[0].message.content}
      await admin.firestore().collection('logs').add({
      
        messageResponse: openAIResponse.choices[0].message,
        from,
        imageUrl
        });

    }

    return response;
}


exports.fetchHorarioColeta = onRequest({
    timeoutSeconds: 10,
}, async (request, response) => {
// Parâmetros para a requisição ao endpoint
const { lat, lng, to } = request.body;
const dst = '50'; // Distância padrão
const limit = '5'; // Limite padrão de resultados

const ecourbis_url = `https://apicoleta.ecourbis.com.br/coleta?lat=${lat}&lng=${lng}&dst=${dst}&limit=${limit}`;
const loga_url = `https://webservices.loga.com.br/sgo/eresiduos/BuscaPorLatLng?distance=${dst}&lat=${lat}&lng=${lng}`

try {
    // Verifica se há resultados na resposta ECOURBIS
    let { data } = await axios.get(ecourbis_url);
    let msg = "A sua região não é atendida por coleta seletiva."
    logger.info('API ECOURBIS Response', { data });

    if (data && data.result && data.result.length > 0) {
        console.log('EcoUrbis encontado!')
        msg = await parseHorarioResponseEcourbis(data.result[0]);
    } else {
        
        // Verifica se há resultados na resposta LOGA
        let { data } = await axios.get(loga_url);
        logger.info('API Loga Response', { data });
        if (data && data.result) {
            console.log('Loga encontado!')
            if (data.found) {
                msg = await parseHorarioResponseLoga(data.result.Logradouros);
            }
        }
    }
    
    if (to) {
        activateStudio(to, { "mensagem" : mensagem });
    }
    
    response.status(200).send(msg);
    } catch (error) {
    
        logger.error("Erro na API", { error });
        const errorMsg = "Desculpe, parece que tivemos um erro.";
        if (to) {
            activateStudio(to, { "mensagem" : errorMsg });
        }
        response.status(500).send(errorMsg);
    }
});

async function parseHorarioResponseEcourbis(coletaDataResponse) {
	const horariosDomiciliar = coletaDataResponse.domiciliar.horarios;
	const horariosSeletiva = coletaDataResponse.seletiva.horarios;

	// Construindo a string de resposta
	let resposta = 'Os horários de coleta no seu local são:\nLixo comum:\n';
	Object.keys(horariosDomiciliar).forEach(dia => {
        resposta += `${dia}: ${horariosDomiciliar[dia]}\n`;
	});

	resposta += '\nColeta seletiva:\n';
	Object.keys(horariosSeletiva).forEach(dia => {
			if (horariosSeletiva[dia] !== '-') { // Inclui apenas os dias com horário definido
					resposta += `${dia}: ${horariosSeletiva[dia]}\n`;
			}
	});

	resposta += '\nAtenção: Os horários, quando informados, estão sujeitos à defasagem em virtude dos seguintes fatores: aumento de resíduos disponibilizados no setor, principalmente às segundas e terças-feiras, trânsito, desvios, interdição de vias, e/ou quaisquer outros alheios à operação.';
	return resposta;
}

async function parseHorarioResponseLoga(coletaData) {
    let resposta = 'Os horários de coleta no seu local são:\nLixo comum:\n';
    // Coleta domiciliar
    if (coletaData[0]) {
        const domiciliar = coletaData.Domiciliar;
        const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];
        
        dias.forEach(dia => {
            console.log(`Has${dia}`)
            const hasDia = domiciliar[`Has${dia}`];
            
            if (hasDia) {
                const horario = domiciliar[`Hora${dia}`];
                resposta += `${dia}: ${horario}\n`;
            }
        });
    }

    resposta += '\nColeta seletiva:\n';
    // Coleta seletiva
    if (coletaData[0].Seletiva) {
        const seletiva = coletaData.Seletiva;
        const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];

        dias.forEach(dia => {
            const hasDia = seletiva[`Has${dia}`];
            if (hasDia) {
                const horario = seletiva[`Hora${dia}`];
                resposta += `${dia}: ${horario}\n`;
            }
        });
    }

    resposta += '\nAtenção: Os horários, quando informados, estão sujeitos à defasagem em virtude dos seguintes fatores: aumento de resíduos disponibilizados no setor, principalmente às segundas e terças-feiras, trânsito, desvios, interdição de vias, e/ou quaisquer outros alheios à operação.';
    return resposta;
}
