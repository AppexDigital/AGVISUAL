const https = require('https');

exports.handler = async (event) => {
    const { id } = event.queryStringParameters;

    if (!id) {
        return { statusCode: 400, body: 'Falta ID' };
    }

    const initialUrl = `https://drive.google.com/uc?export=view&id=${id}`;
    console.log(`Proxy: Solicitando ID ${id}`);

    // Función auxiliar para manejar redirecciones (Recursiva)
    const fetchUrl = (url) => {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                // CASO 1: REDIRECCIÓN (302, 303, 307) - Google hace esto siempre
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    console.log("Proxy: Google redirigió (302) -> Siguiendo...");
                    // IMPORTANTE: Resolvemos la promesa con el RESULTADO de la nueva llamada
                    // y NO seguimos ejecutando código aquí abajo.
                    resolve(fetchUrl(res.headers.location));
                    return; 
                }

                // CASO 2: ÉXITO (200) - Aquí viene la imagen real
                if (res.statusCode === 200) {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    
                    res.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        const base64 = buffer.toString('base64');
                        const contentType = res.headers['content-type'] || 'image/jpeg';
                        
                        console.log(`Proxy: Imagen descargada (${buffer.length} bytes). Enviando...`);
                        
                        resolve({
                            statusCode: 200,
                            headers: {
                                'Content-Type': contentType,
                                'Access-Control-Allow-Origin': '*', // Clave para que el PDF no falle
                                'Cache-Control': 'public, max-age=31536000'
                            },
                            body: base64,
                            isBase64Encoded: true
                        });
                    });
                    return;
                }

                // CASO 3: ERROR (404, 403, 500)
                console.error(`Proxy: Error ${res.statusCode}`);
                resolve({ 
                    statusCode: res.statusCode, 
                    body: `Google Error: ${res.statusMessage}` 
                });

            }).on('error', (e) => {
                console.error("Proxy: Error de red", e);
                resolve({ statusCode: 500, body: e.message });
            });
        });
    };

    // Iniciamos la cadena
    return await fetchUrl(initialUrl);
};
