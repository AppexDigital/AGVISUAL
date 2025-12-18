const https = require('https');

exports.handler = (event, context, callback) => {
    // Log de vida inmediato
    console.log(">>> PROXY ACTIVO. ID Solicitado:", event.queryStringParameters.id);

    const { id } = event.queryStringParameters;

    if (!id) {
        return callback(null, { statusCode: 400, body: 'Falta ID' });
    }

    const url = `https://drive.google.com/uc?export=view&id=${id}`;

    // Función recursiva para seguir redirecciones de Google (302)
    const downloadImage = (currentUrl) => {
        https.get(currentUrl, (res) => {
            // 1. Manejo de Redirección (Google siempre hace esto primero)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log(">>> Redireccionando a Google Content...");
                return downloadImage(res.headers.location);
            }

            // 2. Si no es 200 OK, error
            if (res.statusCode !== 200) {
                console.error(">>> Error Google:", res.statusCode);
                return callback(null, { statusCode: res.statusCode, body: 'Error Google' });
            }

            // 3. Descarga exitosa (Stream)
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));

            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const base64 = buffer.toString('base64');
                const contentType = res.headers['content-type'] || 'image/jpeg';

                console.log(`>>> ÉXITO: Imagen descargada (${buffer.length} bytes). Enviando...`);

                callback(null, {
                    statusCode: 200,
                    headers: {
                        'Content-Type': contentType,
                        'Access-Control-Allow-Origin': '*', // LLAVE MAESTRA CORS
                        'Cache-Control': 'public, max-age=31536000'
                    },
                    body: base64,
                    isBase64Encoded: true
                });
            });

        }).on('error', (e) => {
            console.error(">>> Error Red:", e.message);
            callback(null, { statusCode: 500, body: e.message });
        });
    };

    // Iniciar proceso
    downloadImage(url);
};
