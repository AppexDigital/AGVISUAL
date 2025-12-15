const { schedule } = require('@netlify/functions');

// Definimos la función normal primero
const myHandler = async (event, context) => {
    console.log("LOG: Ejecución Programada (Cron) detectada.");
    return {
        statusCode: 200,
        body: "¡ESTOY VIVO! Y ahora funciono con el Cron Job activado."
    };
};

// TRUCO MAESTRO: Envolvemos la función con 'schedule'
// Esto conecta el código con la configuración del toml sin que explote.
// El horario aquí ("0 6,18 * * *") debe coincidir con el del toml.
module.exports.handler = schedule("0 6,18 * * *", myHandler);;
