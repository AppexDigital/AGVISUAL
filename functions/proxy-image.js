const fetch = require('node-fetch');

exports.handler = async (event) => {
    const { id } = event.queryStringParameters;

    if (!id) return { statusCode: 400, body: 'Falta ID' };

    // URL oficial de Google para ver archivos por ID
    const url = `https://drive.google.com/uc?export=view&id=${id}`;

    try {
        const response = await fetch(url);
        
        if (!response.ok) {
            return { statusCode: response.status, body: `Error Google: ${response.statusText}` };
        }

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type') || 'image/jpeg';

        return {
            statusCode: 200,
            headers: {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*', // <--- ESTO ES LO QUE ARREGLA EL ERROR CORS
                'Cache-Control': 'public, max-age=31536000'
            },
            body: buffer.toString('base64'),
            isBase64Encoded: true
        };
    } catch (error) {
        console.error("Proxy Error:", error);
        return { statusCode: 500, body: error.toString() };
    }
};
