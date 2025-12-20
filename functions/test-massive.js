exports.handler = async (event, context) => {
    try {
        // 1. SEGURIDAD: Accedemos a la llave desde la bóveda de Netlify
        // Esta variable NO existe en el navegador, solo aquí en el servidor.
        const apiKey = process.env.API_KEY_FOTOS;

        if (!apiKey) {
            return { statusCode: 500, body: JSON.stringify({ error: "Configuración de servidor incompleta (Falta API Key)." }) };
        }

        // --- SIMULACIÓN DE TU LÓGICA DE CARGA ---
        // Aquí iría tu código actual que ya funciona y envía la foto a la API externa.
        // Asumiremos que la API externa te respondió exitosamente con las URLs.
        
        // Supongamos que subiste 3 fotos o generaste 3 versiones (thumbnail, medium, full)
        // O que el usuario subió 3 archivos.
        const fakeResponseFromExternalAPI = [
            "https://placehold.co/600x400/0A3832/F1EEEB?text=Foto+1+Subida",
            "https://placehold.co/600x400/B5CC6A/050505?text=Foto+2+Subida",
            "https://placehold.co/600x400/C40F3A/F1EEEB?text=Foto+3+Subida"
        ];

        // 2. RESPUESTA ESTRUCTURADA
        // Devolvemos un JSON claro con el array de links para el frontend.
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: "Carga exitosa",
                urls: fakeResponseFromExternalAPI // Aquí van tus links reales
            })
        };

    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
