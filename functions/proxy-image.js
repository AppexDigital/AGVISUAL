const https = require('https');

exports.handler = async (event) => {
    const { id } = event.queryStringParameters;

    if (!id) {
        return { statusCode: 400, body: 'Falta ID' };
    }

    const initialUrl = `https://drive.google.com/uc?export=view&id=${id}`;
    console.log(`Proxy: Solicitando ID ${id}`);

    const fetchUrl = (url) => {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                // Manejo de Redirecciones (Recursivo)
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    console.log("Proxy: Redireccionando...");
                    resolve(fetchUrl(res.headers.location));
                    return;
                }

                // Éxito: Procesar imagen
                if (res.statusCode === 200) {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    
                    res.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        const base64 = buffer.toString('base64');
                        
                        // IMPORTANTE: Detectar tipo MIME real o usar fallback seguro
                        let contentType = res.headers['content-type'];
                        if (!contentType || contentType === 'application/octet-stream') {
                            // Intentar adivinar por "magic bytes" (muy básico)
                            if (base64.startsWith('/9j/')) contentType = 'image/jpeg';
                            else if (base64.startsWith('iVBORw0KGgo')) contentType = 'image/png';
                            else contentType = 'image/jpeg'; // Default seguro
                        }

                        console.log(`Proxy: Éxito. Tipo: ${contentType}, Tamaño: ${buffer.length}`);
                        
                        resolve({
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
                    return;
                }

                // Error
                console.error(`Proxy: Error ${res.statusCode}`);
                resolve({ statusCode: res.statusCode, body: `Error: ${res.statusMessage}` });

            }).on('error', (e) => {
                console.error("Proxy: Error red", e);
                resolve({ statusCode: 500, body: e.message });
            });
        });
    };

    return await fetchUrl(initialUrl);
};
