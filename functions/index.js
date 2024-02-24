const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const {defineString} = require('firebase-functions/params');
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
                 }})
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
        const openaiResponse = await analyzeImageWithOpenAI(imageUrl, request.body.from);
        activateStudio(request.body.to, request.body.from, openaiResponse)

        response.status(200).send(JSON.stringify(openaiResponse));
    } catch (error) {
        logger.error('Erro ao processar a imagem', error);
        response.status(500).send('Erro interno');
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
    const response = await openai.chat.completions.create({
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
  
    // Assumindo que a resposta da OpenAI vem no formato esperado, você pode precisar fazer um parse adicional
    // dependendo de como a informação é formatada na resposta.
    console.log(response.choices[0].message.content);

    await admin.firestore().collection('logs').add({
        response: response.choices[0],
        from,
        imageUrl
    });
  
    // Aqui você retornaria a resposta processada conforme necessário para seu uso.
    // Isso pode envolver converter a string JSON em um objeto JavaScript para facilitar o manuseio.
    return JSON.parse(response.choices[0].message.content);
  }
