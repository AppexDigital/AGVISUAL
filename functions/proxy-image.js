const https = require('https');

exports.handler = async (event) => {
    // Log inicial para saber que entramos
    console.log("PROXY START: ", event.queryStringParameters);
    
    const id = event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: 'Falta ID' };

    const url = `https://drive.google.com/uc?export=view&id=${id}`;

    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            // Seguir redirección (302)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log("PROXY: Redireccionando...");
                // Hacemos una segunda llamada simple a la nueva URL
                https.get(res.headers.location, (res2) => {
                     let data = [];
                     res2.on('data', chunk => data.push(chunk));
                     res2.on('end', () => {
                         const buffer = Buffer.concat(data);
                         const base64 = buffer.toString('base64');
                         const type = res2.headers['content-type'] || 'image/jpeg';
                         console.log("PROXY: Éxito (Redirección). Bytes:", buffer.length);
                         resolve({
                             statusCode: 200,
                             headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' },
                             body: base64,
                             isBase64Encoded: true
                         });
                     });
                });
                return;
            }

            // Descarga directa
            let data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(data);
                const base64 = buffer.toString('base64');
                const type = res.headers['content-type'] || 'image/jpeg';
                console.log("PROXY: Éxito (Directo). Bytes:", buffer.length);
                resolve({
                    statusCode: 200,
                    headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' },
                    body: base64,
                    isBase64Encoded: true
                });
            });
        });
        
        req.on('error', e => {
            console.error("PROXY ERROR:", e);
            resolve({ statusCode: 500, body: e.message });
        });
    });
};
