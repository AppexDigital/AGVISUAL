const https = require('https');

exports.handler = (event, context, callback) => {
    const { id } = event.queryStringParameters;

    if (!id) {
        return callback(null, { statusCode: 400, body: 'Falta ID' });
    }

    const initialUrl = `https://drive.google.com/uc?export=view&id=${id}`;

    // Función recursiva para seguir redirecciones
    const download = (url) => {
        https.get(url, (res) => {
            // 1. Manejo de Redirección (Google Drive siempre redirige)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return download(res.headers.location);
            }

            // 2. Descarga de Datos
            const data = [];
            res.on('data', (chunk) => data.push(chunk));

            res.on('end', () => {
                const buffer = Buffer.concat(data);
                const base64 = buffer.toString('base64');
                
                // Si Google no dice qué es, asumimos JPEG (común en logos escaneados)
                let contentType = res.headers['content-type'];
                if (!contentType || contentType === 'application/octet-stream') {
                    contentType = 'image/jpeg';
                }

                // 3. Respuesta Exitosa
                callback(null, {
                    statusCode: 200,
                    headers: {
                        'Content-Type': contentType,
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'public, max-age=31536000'
                    },
                    body: base64,
                    isBase64Encoded: true
                });
            });

        }).on('error', (e) => {
            console.error("Proxy Error:", e);
            callback(null, { statusCode: 500, body: e.message });
        });
    };

    // Iniciar
    download(initialUrl);
};
