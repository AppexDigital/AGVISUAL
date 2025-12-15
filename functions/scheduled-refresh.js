// functions/scheduled-refresh.js
// V26.0 - MODO ESM NATIVO (MODERNO)

// Usamos la sintaxis moderna que tus librerías v5 exigen
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { google } from 'googleapis';

// Exportación moderna
export const handler = async (event, context) => {
    console.log(">>> LOG: ROBOT INICIADO (Modo ESM)");

    // PRUEBA DE VIDA INICIAL
    // Si ves este texto, significa que el conflicto de versiones se arregló.
    return {
        statusCode: 200,
        body: "¡ESTOY VIVO! El sistema Scheduled funciona en modo ESM Moderno."
    };
};
