// functions/proxy-image.js

exports.handler = async (event) => {
    // 1. Log de vida inmediato
    console.log(">>> PROXY INICIADO. Query:", event.queryStringParameters);

    const { id } = event.queryStringParameters;

    if (!id) {
        console.error(">>> ERROR: Falta ID");
        return { statusCode: 400, body: 'Falta ID' };
    }

    const url = `https://drive.google.com/uc?export=view&id=${id}`;

    try {
        // 2. Fetch Nativo (Sigue redirecciones 302 automáticamente)
        const response = await fetch(url);

        if (!response.ok) {
            console.error(`>>> ERROR GOOGLE: ${response.status} ${response.statusText}`);
            return { statusCode: response.status, body: response.statusText };
        }

        // 3. Procesamiento de Buffer
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');
        const contentType = response.headers.get('content-type') || 'image/jpeg';

        console.log(`>>> ÉXITO: Imagen descargada. Bytes: ${buffer.length}, Tipo: ${contentType}`);

        // 4. Respuesta Binaria (Netlify decodifica el base64 body al navegador)
        return {
            statusCode: 200,
            headers: {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=31536000'
            },
            body: base64,
            isBase64Encoded: true
        };

    } catch (error) {
        console.error(">>> ERROR CRÍTICO:", error);
        return { statusCode: 500, body: error.message };
    }
};
