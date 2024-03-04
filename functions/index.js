const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { defineString } = require('firebase-functions/params');

const axios = require('axios'); // Para chamadas HTTP
const OpenAI = require('openai');

const admin = require('firebase-admin');
const { toBase64 } = require("openai/core");
const { AggregateField } = require("firebase-admin/firestore");
admin.initializeApp();

const OPENAI_API_KEY = defineString('OPENAI_API_KEY');
const TWILIO_ACCOUNT_SID = defineString('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineString('TWILIO_AUTH_TOKEN');
const TWILIO_STUDIO_FLOW_SID = defineString('TWILIO_STUDIO_FLOW_SID');
const TWILIO_MESSAGE_SERVICE_SID = defineString('TWILIO_MESSAGE_SERVICE_SID');

const MAX_REQUESTS_PER_USER = 10; // Limite de requisições por usuário
let RESTRICTION_ACTIVE = true;


const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });

const downloadTwilioMedia = async (mediaUrl) => {

    const auth = `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`;
    const base64Auth = await toBase64(auth);
    const headers = {
        'Authorization': `Basic ${base64Auth}` 
    }

    // https://api.twilio.com/2010-04-01/Accounts/ACd1efbf440fe192f1a8439ecb9415de9c/Messages/MMb54485bb0503d1981af2711d2e9fb010/Media/ME8af513cafb93e0b566fafdf4b33cd964
    
    return await axios
        .get(mediaUrl, {
            responseType: 'arraybuffer',
            // headers,
            auth: {
                username: TWILIO_ACCOUNT_SID.value(),
                password: TWILIO_AUTH_TOKEN.value()
            }
        })
        .then(response => {
            const result = {
                contentType: response.headers['content-type'],
                base64: Buffer.from(response.data, 'binary').toString('base64')
            }
            return result;
        }).catch(e => {
            logger.error('ERROR!', e);
            return null;
        });
}

const activateStudio = async (to, json) => {
    const client = require('twilio')(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());

    logger.info(`activateStudio: executando via ${TWILIO_MESSAGE_SERVICE_SID.value()}`);

    client.studio.v2.flows(TWILIO_STUDIO_FLOW_SID.value())
    .executions
    .create({
        to, 
        from: TWILIO_MESSAGE_SERVICE_SID.value(),
        parameters: {
            json
        }
    })
    .then(execution => console.log(execution.sid));

}
// Defina suas variáveis de ambiente no Firebase.

exports.identificaLixo = onRequest(async (request, response) => {
    logger.info('IDENTIFICAR IMAGEM', request.body);

    const imageUrl = request.body.url; // A URL da imagem enviada via Twilio.
    
    if (!imageUrl) {
        logger.error('Nenhuma URL de imagem fornecida');
        response.status(400).send('Nenhuma URL de imagem fornecida');
        return;
    }

    if (RESTRICTION_ACTIVE && !await checkAndUpdateRequestCounter(request.body.to)) {
        // Se a restrição estiver ativa e o limite for atingido, retorne um erro
        let msg = "Lamentamos, mas você atingiu seu limite atual de 10 solicitações. Estamos constantemente trabalhando para expandir nossos serviços e, em breve, ofereceremos opções ilimitadas. Agradecemos sua compreensão e paciência. Fique atento para atualizações futuras que permitirão que você aproveite ainda mais nosso serviço."
        activateStudio(request.body.to, { "mensagem" : msg });
        logger.info('Limite de requisições atingido', request.body.to);
        response.status(200).send(msg);
        return;
    }

    try {
        // Simulação de análise de imagem pela OpenAI. Substitua isso pela sua implementação real.
        const aiResponse = await analyzeImageWithOpenAI(imageUrl, request.body.from, request.body.to, request.body.profileName);
        activateStudio(request.body.to, aiResponse);
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

    try {
        // Adiciona todos os pontos de coleta como um único objeto/documento no Firestore
        await admin.firestore().collection('pontosColeta').doc('todosPontos').set({dados});
        logger.info('Dado enviados:', dados);
        response.status(200).send("Dados importados com sucesso como um único objeto para a coleção pontosColeta.");
    } catch (error) {
        console.error("Erro ao importar dados: ", error);
        response.status(500).send("Erro ao importar dados como um único objeto para a coleção pontosColeta.");
    }
});


exports.listaEcopontos = onRequest(async (request, response) => {
    const geofire = require('geofire-common');
    if (!request.body.lat || !request.body.lng) {
        return response.contentType('application/json').status(200).send(JSON.stringify({
            mensagem: `Parâmetros informados para a busca estão inválidos.`
        }));
    }
    const geo = {
        lat: parseFloat(request.body.lat),
        lng: parseFloat(request.body.lng)
    };
    let center = [geo.lat, geo.lng];
    let radiusInM = request.body.radius ? parseInt(request.body.radius) : 5 * 1000; // Raio padrão de 5 km

    let dados = require('./data/pontosColeta.json');

    // Filtrar tipos solicitados primeiro
    const tipos = request.body.filtro ? request.body.filtro.toLowerCase().split(', ') : [];
    if (tipos.length > 0) {
        dados = dados.filter(e => {
            return e.itens_recebidos.some(function(item) {
                return tipos.includes(item);
            });
        });
    }

    // Filtrar por geohash
    const bounds = geofire.geohashQueryBounds(center, radiusInM);

    let ecopontos = [];
    const promises = [];
    let i = 0;
    for (const b of bounds) {
        const items = dados.filter(d => {
            return d.geohash >= b[0] && d.geohash <= b[1]
        });
        ecopontos = ecopontos.concat(items);
    }

    // Calcular distância de cada item encontrado
    ecopontos = ecopontos.map((e) => {
        e.distanceInKm = geofire.distanceBetween([parseFloat(e.latitude), parseFloat(e.longitude)], center);
        e.distanceInM = e.distanceInKm * 1000;
        console.log('distanceInKm', e.distanceInM);
        return e;
    });

    // Segundo filtro de distância
    ecopontos = ecopontos.filter(e => e.distanceInM <= radiusInM);
    ecopontos = ecopontos.sort((a, b) => {
        return a.distanceInM - b.distanceInM;
    });

    // Selecionar o ponto de coleta mais próximo
    const pontoMaisProximo = ecopontos.length > 0 ? ecopontos[0] : null;
    if (pontoMaisProximo) {
        logger.info('RESULTADO GEOHASH', pontoMaisProximo);
        response.contentType('application/json').status(200).send(JSON.stringify(formatarRespostaListaPonto(pontoMaisProximo)));
    } else {
        logger.info('RESULTADO GEOHASH: SEM ECOPONTO');
        response.contentType('application/json').status(200).send(JSON.stringify({
            mensagem: `Não encontrei nenhum ecoponto em um raio de 5 quilômetros da sua localização.`
        }));
    }

    // response.send(`DADOS: ${dados.length}\n\n\n${JSON.stringify(ecopontos)}`);
});

exports.gerarDicaRandomica = onRequest(async (request, response) => {
    const dicas = [
        { 
            mensagem: `*Compre a granel:* Comprar a granel pode ajudar a reduzir a quantidade de embalagens individuais que você consome. Procure lojas que oferecem opções a granel para itens como alimentos, produtos de limpeza e itens de higiene pessoal.`,
            imagem: ``
        },
        { 
            mensagem: `*Recicle corretamente:* Certifique-se de separar seus resíduos em materiais recicláveis e não-recicláveis e lembre de manter os recicláveis SECOS e LIMPOS para evitar contaminação. Se tiver dúvida sobre um item, mande a foto aqui 😉`,
            imagem: ``
        },
        { 
            mensagem: `*Escolha produtos com menos embalagens:* Ao comprar produtos, prefira aqueles que possuem menos embalagens ou que vêm em embalagens recicláveis. Evite produtos excessivamente embalados em plástico ou outros materiais não-recicláveis.`,
            imagem: ``
        },
        { 
            mensagem: `*Símbolo de FSC (Forest Stewardship Council):* Se você estiver procurando por produtos de papel ou madeira, pode procurar por produtos certificados pelo FSC. Este rótulo indica que o produto foi produzido de forma sustentável, considerando os aspectos ambientais, sociais e econômicos da sua produção.`,
            imagem: ``
        },
        { 
            mensagem: `*📷 Descarte seus móveis 🛏️ 🛋️ 🪑danificados em um ECOPONTO:* A cidade de São Paulo conta com Ecopontos especializados em dar o destino correto para seus móveis. Se puder, dirija-se até um local próximo e evite que esse material vá parar em um aterro, onde ficará por centenas de anos. Mande a foto do seu móvel aqui e compartilhe sua localização para que o Reciclar.ia te indique o ecoponto mais próximo😉`,
            imagem: ``
        }

    ]
    let dica = dicas[Math.floor(Math.random() * dicas.length)];
    response.contentType('application/json').status(200).send(JSON.stringify(dica));
});



const getFirestorePrompt = async () => {    
    // const settings = await admin.firestore().collection('settings').doc('default').get();
    // if (settings.exists) {
    //     settingsData = await settings.data();
    //     logger.info('EXISTE', settingsData.promptImagem);
    //     return settingsData.promptImagem;
    // }

    return `Esta é a imagem de um lixo, faça uma análise completa e retorne um arquivo json seguinte formato:  {     "objeto" : <nome do objeto ou objetos>,          "material": <composição aproximada do material ou materiais em formato de texto>,          "emoji_material" : <emoji que melhor representa o material em formato de texto>,          "tipo_de_descarte" : <"reciclável", "lixo eletrônico", "compostagem", "descarte simples">,          “potencial de reciclagem” : <“potencial de reciclagem do lixo e informações sobre o que pode ser gerado a partir da reciclagem do item”>          "condicao_descarte" : <avisos sobre cuidados específicos para que o lixo possa ser descartado adequadamente">,          "reuso": <"sim", "não", "talvez">,          "possibilidades_criativas_de_reuso" : <uma ideia interessante para uso criativo e artístico>           "justificativa_talvez" :  <explique porque você esta em dúvida>,     "ecoponto": <"raio-x", "cápsulas de café", "isopor", "sobras de poda de árvore", "cimento", "lixo eletrônico", "pilhas e baterias", "esponjas", "papel", "alumínio", "materiais volumosos", "metal", "lâmpadas", "entulho", "sandálias", "plástico", "móveis velhos", "restos de azulejos", "chinelos", "madeiras", "medicamentos", "resíduos da construção civil", "tecidos", "tijolo", "esponja", "óleo", "vidro", "Nenhum"> } Caso tenha mais de um material identificado, considere que os campos devem incluir todos eles e não crie um vetor. Caso seja parte de uma pessoa, foque no objeto que ela está usando ou que esteja em primeiro plano. Retorne APENAS o conteúdo do JSON de forma textual e nada mais. Deve ser um JSON válido.`;

    // return `Esta é a imagem de um lixo, faça uma análise completa e retorne um arquivo json seguinte formato:
            
    // {
    //     "objeto" : <nome do objeto>,
    //     "material": <composição aproximada do material>,
    //     "emoji_material" : <emoji que melhor representa o material>,
    //     "tipo_de_descarte" : <"reciclavel", "lixo eletrônico", "compostagem", "descarte simples">,
    //     "condicao_descarte" : <avisos sobre cuidados específicos para que o material possa ser descartado adequadamente">,
    //     "reuso": <"sim", "não", "talvez">,
    //     "possibilidades_criativas_de_reuso" : <uma ideia interessante para uso criativo e artistico>
    //     "justificativa_talvez" :  <explique porque você esta em dúvida>
    // }

    // Retorne APENAS o conteúdo do JSON de forma textual e nada mais. Deve ser um JSON válido.
    // `;
}

async function analyzeImageWithOpenAI(imageUrl, from, to, profileName) {
    const imageBase64 = await downloadTwilioMedia(imageUrl);

    logger.info('imageBase64', imageBase64);

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
                "url": `data:${imageBase64.contentType};base64,${imageBase64.base64}`,
              },
            },
          ],
        },
      ],
    });
    logger.info('OPENAI Response', openAIResponse)
    let response = openAIResponse.choices[0].message.content.split('```json').join('').split('```').join('')
    // Assumindo que a resposta da OpenAI vem no formato esperado, você pode precisar fazer um parse adicional
    // dependendo de como a informação é formatada na resposta.
    console.log(response);
    try {
        response = JSON.parse(response)
        await admin.firestore().collection('logs').add({
            timestamp: admin.firestore.Timestamp.now(),
            messageResponse: openAIResponse.choices[0].message,
            response: response,
            from,
            to,
            profileName,
            imageUrl,
            usage: openAIResponse.usage
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

async function checkAndUpdateRequestCounter(userIdentifier) {
    const userRef = admin.firestore().collection('requestCounters').doc(userIdentifier);
    const doc = await userRef.get();

    if (!doc.exists) {
        logger.info(`FIRTS TIME `)
        await userRef.set({ count: 1 }); // Se não existir, inicialize o contador
        return true; // Primeira requisição, continue
    } else {
        let count = doc.data().count;
        logger.info(`COUNT: ${count}`)
        if (count >= MAX_REQUESTS_PER_USER) {
            return false; // Limite atingido, bloqueie a requisição
        } else {
            await userRef.update({ count: count + 1 }); // Atualize o contador
            return true; // Ainda dentro do limite, continue
        }
    }
}

exports.uso = onRequest(async (request, response)=> {

    if (request.query.password != 'uma palma') {
        logger.error(`INVALID PASSWORD ${request.query.password}`);
        return response.status('401').send('Acesso não permitido!');
    }

    // AggregateField.sum()
    const doc = await admin.firestore().collection('logs').aggregate({
        total_logs: AggregateField.count(),
        tokens_total: AggregateField.sum('usage.total_tokens'),
        tokens_average: AggregateField.average('usage.total_tokens')
    }).get();

    const data = doc.data();
    logger.info('OPENAI USAGE', data);
    response.contentType('application/json').send(JSON.stringify(data));
});

exports.fetchHorarioColeta = onRequest({
    timeoutSeconds: 10,
}, async (request, response) => {
    // Parâmetros para a requisição ao endpoint
    const { lat, lng, to } = request.body;
    const dst = '50'; // Distância padrão
    const limit = '5'; // Limite padrão de resultados

    const ecourbis_url = `https://apicoleta.ecourbis.com.br/coleta?lat=${lat}&lng=${lng}&dst=${dst}&limit=${limit}`;
    // const ecourbis_url = `https://apicoleta.ecourbis.com.br/coleta?lat=-23.6193175&lng=-46.682458&dst=100`;
    const loga_url = `https://webservices.loga.com.br/sgo/eresiduos/BuscaPorLatLng?distance=${dst}&lat=${lat}&lng=${lng}`
    const header = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
    }

    let found = false;
    let msg = `Infelizmente, a sua região não foi encontrada nos pontos de coleta seletiva da LOGA. Caso sua localidade seja atendida pela a ECOURBIS não é possível fazer a consulta neste momento. :(`

    // try {
        // Verifica se há resultados na resposta ECOURBIS
        // logger.info('URL URBIS', ecourbis_url);
        // let { data } = await axios.get(ecourbis_url, { headers: header });

        // logger.info('API ECOURBIS Response', { data });
        // if (data && data.result && data.result.length > 0) {
        //     logger.info('RECEBEU DATA URBIS');
        //     found = true;    
        //     msg = await parseHorarioResponseEcourbis(data.result[0]);
        // } else {
        //     logger.info('SEM DATA URBIS');
        // }

        // Verifica se há resultados na resposta LOGA
        if (!found) {
            logger.info('URL LOGA', loga_url);
            let { data } = await axios.get(loga_url, { headers: header });
            logger.info('API Loga Response', { data });
            if (data && data.result) {
                console.log('Loga encontado!')
                found = true;
                if (data.found) {
                    msg = await parseHorarioResponseLoga(data.result.Logradouros);
                }
            }
        }
    // } catch (error) {
    //     logger.error("Erro na API Loga", { error });
    //     if (to) {
    //         activateStudio(to, { "mensagem" : "Infelizmente tivemos um erro. Tente mais tarde." });
    //     }
    // }

    
    if (to) {
        activateStudio(to, { "mensagem" : msg });
    }
    
    response.status(200).send(msg);

});

async function parseHorarioResponseEcourbis(coletaDataResponse) {
    logger.info('PARSE ECOURBIS', coletaDataResponse);
	const horariosDomiciliar = coletaDataResponse.domiciliar.horarios;
	const horariosSeletiva = coletaDataResponse.seletiva.horarios;

	// Construindo a string de resposta
	let resposta = 'Quem te atende é a Ecourbis!\nOs horários de coleta no seu local são:\nLixo comum:\n';
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
    logger.info('PARSE LOGA', coletaData);

    let resposta = 'Quem te atende é a Loga!\nOs horários de coleta no seu local são:\nLixo comum:\n';
    // Coleta domiciliar
    if (coletaData[0]) {
        const domiciliar = coletaData[0].Domiciliar; //deve dar bool
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
        const seletiva = coletaData[0].Seletiva;
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

function formatarRespostaListaPonto(ponto) {
    return {
        mensagem: `Encontrei o seguinte ecoponto próximo de você:\n\n*${ponto.nome}*\n\n${ponto.endereco}\nCep: ${ponto.cep}\n\n*${ponto.distanceInM.toFixed(0)} metro(s) de você.*\n\nTelefone: ${ponto.telefone}\nHorário de Funcionamento: ${ponto.horario_funcionamento}.\n\nItens aceitos: ${ponto.itens_recebidos.join(', ')}`,
        location: {
            lat: ponto.latitude,
            lng: ponto.longitude
        },
        nome: ponto.nome,
        ponto: ponto
    };
}