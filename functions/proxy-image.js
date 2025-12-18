const fetch = require('node-fetch');

exports.handler = async (event) => {
    const { id } = event.queryStringParameters;

    if (!id) return { statusCode: 400, body: 'Falta ID' };

    // URL directa de Google Drive para descarga
    const url = `https://drive.google.com/uc?export=view&id=${id}`;

    try {
        const response = await fetch(url);
        
        if (!response.ok) throw new Error(`Error fetching image: ${response.statusText}`);

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type');

        return {
            statusCode: 200,
            headers: {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*', // <--- LA LLAVE MAESTRA
                'Cache-Control': 'public, max-age=31536000'
            },
            body: buffer.toString('base64'),
            isBase64Encoded: true
        };
    } catch (error) {
        console.error(error);
        return { statusCode: 500, body: error.toString() };
    }
};
