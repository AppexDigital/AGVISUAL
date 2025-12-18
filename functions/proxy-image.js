const https = require('https');

exports.handler = async (event) => {
    const { id } = event.queryStringParameters;

    if (!id) {
        console.error("Proxy: Falta ID");
        return { statusCode: 400, body: 'Falta ID' };
    }

    const url = `https://drive.google.com/uc?export=view&id=${id}`;
    console.log(`Proxy: Iniciando descarga para ID ${id}`);

    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            // Manejo de redirecciones de Google (común en Drive)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log("Proxy: Redireccionando...");
                return https.get(res.headers.location, (res2) => processResponse(res2, resolve, reject));
            }
            processResponse(res, resolve, reject);
        });

        req.on('error', (e) => {
            console.error("Proxy: Error de red", e);
            resolve({ statusCode: 500, body: `Error de red: ${e.message}` });
        });
    });
};

function processResponse(res, resolve, reject) {
    if (res.statusCode !== 200) {
        console.error(`Proxy: Google respondió ${res.statusCode}`);
        resolve({ statusCode: res.statusCode, body: `Error Google: ${res.statusMessage}` });
        return;
    }

    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    
    res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const contentType = res.headers['content-type'] || 'image/jpeg';
        
        console.log(`Proxy: Éxito. Imagen de ${buffer.length} bytes convertida.`);

        resolve({
            statusCode: 200,
            headers: {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*', // Vital para CORS
                'Cache-Control': 'public, max-age=31536000'
            },
            body: base64,
            isBase64Encoded: true
        });
    });

    res.on('error', (e) => {
        console.error("Proxy: Error procesando stream", e);
        resolve({ statusCode: 500, body: "Error procesando imagen" });
    });
}
