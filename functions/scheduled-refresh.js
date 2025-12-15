// NO AGREGUES NINGÚN REQUIRE AQUÍ ARRIBA
// Si pones require, y la librería falta, falla.

exports.handler = async (event, context) => {
    return {
        statusCode: 200,
        body: "SISTEMA OPERATIVO: Netlify está ejecutando código."
    };
};
