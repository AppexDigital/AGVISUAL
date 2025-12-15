// Si esto falla, el problema es que Netlify no ve la carpeta.

exports.handler = async (event, context) => {
    console.log("LOG: La función de prueba ha sido invocada.");
    
    return {
        statusCode: 200,
        body: "¡ESTOY VIVO! El servidor funciona correctamente."
    };
};
