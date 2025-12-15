// functions/scheduled-refresh.js
// PRUEBA DE VIDA - CON PROGRAMACIÓN EN CÓDIGO (ESM)

import { schedule } from '@netlify/functions';

// 1. Definimos la función simple
const myHandler = async (event, context) => {
    console.log(">>> LOG: La función programada (Vía Código) se ejecutó correctamente.");
    
    return {
        statusCode: 200,
        body: "¡ESTOY VIVO! Funcionando con schedule() dentro del código."
    };
};

// 2. Exportamos la función envuelta en el horario
// "0 6,18 * * *" = 6:00 AM y 6:00 PM UTC
export const handler = schedule("0 6,18 * * *", myHandler);
