//functions/proxy-image.js

exports.handler = async (event) => {
    // 1. Obtener ID
    const { id } = event.queryStringParameters;
    
    if (!id) {
        return { statusCode: 400, body: 'Falta el parámetro ID' };
    }

    // 2. URL de Google Drive
    const url = `https://drive.google.com/uc?export=view&id=${id}`;

    try {
        // 3. Usamos el FETCH nativo de Node.js (Sin require)
        const response = await fetch(url);

        if (!response.ok) {
            return { 
                statusCode: response.status, 
                body: `Error al obtener imagen de Google: ${response.statusText}` 
            };
        }

        // 4. Procesamiento de Buffer Nativo
        // Convertimos el ArrayBuffer a Buffer de Node para poder pasarlo a Base64
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString('base64');
        
        // Intentar obtener el tipo de contenido, o asumir jpeg
        const contentType = response.headers.get('content-type') || 'image/jpeg';

        return {
            statusCode: 200,
            headers: {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*', // Vital para CORS
                'Cache-Control': 'public, max-age=31536000'
            },
            body: base64Image,
            isBase64Encoded: true
        };

    } catch (error) {
        console.error("Error en Proxy:", error);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: error.message }) 
        };
    }
};
