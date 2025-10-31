// functions/get-admin-data.js
// v2.1 - Corregido el bug 'headerValues'
// API protegida para obtener TODOS los datos necesarios para el Centro de Mando.

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { validateGoogleToken } = require('./google-auth-helper');

// --- Helpers (Sin cambios) ---
async function getDoc() {
  // ... (código existente sin cambios) ...
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

// *** INICIO DEL AJUSTE DE CIRUJANO v6.1 ***

// Convertir filas a objetos (con encabezados completos)
// Modificado: Ahora acepta 'sheet' para leer headerValues de forma segura
function rowsToObjects(sheet, rows) {
  if (!rows || rows.length === 0) return [];
  
  // CORRECCIÓN: Leer 'headerValues' desde el objeto 'sheet' (que ya los tiene cargados)
  // en lugar de 'rows[0]._sheet' que es propenso a fallos.
  const headers = sheet.headerValues || []; 
  
  return rows.map(row => {
    const obj = {};
    headers.forEach(header => {
      // Asignar el valor o un string vacío si es undefined/null
      obj[header] = row.get(header) !== undefined && row.get(header) !== null ? row.get(header) : '';
    });
    return obj;
  });
}

// *** FIN DEL AJUSTE DE CIRUJANO v6.1 ***

// --- Handler Principal (Actualizado) ---
exports.handler = async (event, context) => {
  // 1. **SEGURIDAD (Actualizado):** Verificar el token de Google del usuario.
  if (!(await validateGoogleToken(event))) {
    return {
// ... (código existente sin cambios) ...
      };
    }
    // Si llegamos aquí, el usuario está autenticado.

// ... (código existente sin cambios) ...
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
      const doc = await getDoc();

      // 3. Definir TODAS las hojas que el Centro de Mando necesita (v1.3)
      const sheetTitles = [
// ... (código existente sin cambios) ...
        'Bookings',
        'BlockedDates'
      ];

      // 4. Leer todas las hojas en paralelo
      const sheetPromises = sheetTitles.map(async (title) => {
        const sheet = doc.sheetsByTitle[title];
        if (!sheet) {
          console.warn(`Admin Data: Hoja "${title}" no encontrada en Google Sheet.`);
          return { title, data: [] }; // Devuelve array vacío si la hoja no existe
        }
        await sheet.loadHeaderRow(); // Asegurarse de que los encabezados están cargados
        const rows = await sheet.getRows();
        
        // *** INICIO DEL AJUSTE DE CIRUJANO v6.1 ***
        // Pasamos el objeto 'sheet' junto con 'rows'
        return { title, data: rowsToObjects(sheet, rows) };
        // *** FIN DEL AJUSTE DE CIRUJANO v6.1 ***
      });

      const results = await Promise.all(sheetPromises);
// ... (código existente sin cambios) ...
      // 5. Estructurar los datos como un objeto
      const adminData = results.reduce((acc, sheetResult) => {
// ... (código existente sin cambios) ...
        acc[sheetResult.title] = sheetResult.data;
        return acc;
      }, {});

      // 6. Devolver la respuesta exitosa
// ... (código existente sin cambios) ...
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adminData),
      };

    } catch (error) {
// ... (código existente sin cambios) ...
      console.error('Error fetching admin data:', error);
      return {
// ... (código existente sin cambios) ...
        statusCode: 500,
        body: JSON.stringify({
            error: 'Falló la obtención de datos para el admin',
            details: error.message
        }),
      };
    }
  };
