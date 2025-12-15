exports.handler = async function(event, context) {
    console.log("LOG DE PRUEBA: La función se ejecutó.");
    
    return {
        statusCode: 200,
        body: "¡ESTOY VIVO! El servidor funciona."
    };
};
