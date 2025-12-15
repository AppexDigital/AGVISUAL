// functions/scheduled-refresh.js
// V40.0 - COMMONJS + DYNAMIC IMPORT (La Solución Definitiva)

const { schedule } = require('@netlify/functions');

// Definimos la función principal
const myHandler = async (event, context) => {
    console.log(">>> ROBOT INICIADO: Modo Compatibilidad");

    try {
        // --- TRUCO: Carga Dinámica de Librerías Modernas ---
        // Esto permite usar la v5 de Google Spreadsheet en un entorno Node estándar
        const { GoogleSpreadsheet } = await import('google-spreadsheet');
        const { JWT } = await import('google-auth-library');
        const { google } = await import('googleapis');

        // Aquí iría tu lógica real. Por ahora, solo probamos que carga las librerías.
        // Si llegamos a esta línea sin error 500, ¡FUNCIONA!
        return {
            statusCode: 200,
            body: "¡ESTOY VIVO! El Robot Programado funciona y cargó las librerías V5."
        };

    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: error.message };
    }
};

// Exportamos usando la sintaxis clásica que a Netlify le encanta
// Horario: 00:00 y 12:00 (Hora Costa Rica aprox)
module.exports.handler = schedule("0 6,18 * * *", myHandler);
