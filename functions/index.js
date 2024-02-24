/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const { defineInt, defineString } = require('firebase-functions/params');

const OPENAI_APIKEY = defineString('OPENAI_APIKEY');

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

exports.identificaLixo = onRequest((request, response) => {
    // https://identificalixo-akbmy6t33q-uc.a.run.app/identificaLixo
    logger.info("Hello logs!", {structuredData: true});
    logger.info('CONTEUDO DA REQUISICAO', request.body);

    // TODO: validar que a requisição veio da Twilio
    // TODO: carregar parâmetros request.body.imagem, request.body.from
    // TODO: donwload da imagem
    // TODO: rodar vision da OpenAI e retornar descritivo
    // TODO: rodar chatGPT com o descritivo e retornar JSON.

    resposta = {
        mensagem: `Ainda em implementação`,
        imagem: null
    }

    response.contentType('application/json';)
    response.send(JSON.stringify(resposta));

});
