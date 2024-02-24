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

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

exports.identificaLixo = onRequest((request, response) => {

    logger.info("Hello logs!", {structuredData: true});
    logger.info('CONTEUDO DA REQUISICAO', request.body);
    // TODO: verificar se retornou imagem
    // TODO: 
    response.send("Hello from Firebase!");

});
