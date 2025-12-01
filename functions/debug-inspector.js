// functions/debug-inspector.js
// ÚSALO PARA DIAGNÓSTICO. BORRAR DESPUÉS.
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

exports.handler = async (event, context) => {
  try {
    // 1. Conexión Directa (Sin validación de token para probar rápido en navegador)
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();

    // 2. Parámetros de prueba (Cámbialos según lo que quieras probar)
    // Si llamas a la url: /.netlify/functions/debug-inspector?sheet=ProjectImages
    const sheetTitle = event.queryStringParameters.sheet || 'ProjectImages';
    
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: `Hoja ${sheetTitle} no encontrada` };

    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();

    // 3. Análisis de Encabezados (RAW)
    const rawHeaders = sheet.headerValues;
    
    // 4. Análisis de la primera fila con datos
    let firstRowData = null;
    if (rows.length > 0) {
        const r = rows[0];
        firstRowData = {};
        // Extraemos valor de CADA encabezado encontrado
        rawHeaders.forEach(h => {
            firstRowData[`[${h}]`] = r.get(h); // Ponemos corchetes para ver si hay espacios
        });
    }

    const report = {
        hoja: sheetTitle,
        encabezados_exactos_en_sheet: rawHeaders.map(h => `"${h}"`), // Comillas para ver espacios
        fila_ejemplo: firstRowData,
        diagnostico: {
            tiene_fileId: rawHeaders.some(h => h.toLowerCase().trim() === 'fileid'),
            tiene_driveFolderId: rawHeaders.some(h => h.toLowerCase().trim() === 'drivefolderid'),
            nombre_columna_fileId_detectado: rawHeaders.find(h => h.toLowerCase().trim() === 'fileid') || "NO ENCONTRADO",
            nombre_columna_folderId_detectado: rawHeaders.find(h => h.toLowerCase().trim() === 'drivefolderid') || "NO ENCONTRADO"
        }
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report, null, 2)
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message, stack: error.stack }) };
  }
};
