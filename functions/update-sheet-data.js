// functions/update-sheet-data.js
// v14.0 - ESTABILIDAD TOTAL (Sin filtros restrictivos)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  return { doc, drive: google.drive({ version: 'v3', auth }) };
}

async function findRows(sheet, criteria) {
    if (!criteria) return [];
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const key = Object.keys(criteria)[0];
    return rows.filter(row => String(row.get(key)) === String(criteria[key]));
}

async function findRow(sheet, criteria) {
  const rows = await findRows(sheet, criteria);
  return rows.length > 0 ? rows[0] : null;
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { sheet: sheetTitle, action, data, criteria } = body;

    const { doc, drive } = await getServices();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: `Hoja ${sheetTitle} no encontrada` }) };
    
    // Cargar encabezados es necesario para algunas operaciones internas de la librería
    await sheet.loadHeaderRow();

    // --- ADD (Crear) ---
    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;

        // Lógica de "Portada Única"
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
           for (const r of rows) { 
               if (r.get(parentKey) === data[parentKey] && r.get('isCover') === 'Si') { 
                   r.set('isCover', 'No'); await r.save(); 
               } 
           }
        }

        // GUARDADO DIRECTO (Sin filtrado estricto para evitar errores silenciosos)
        await sheet.addRow(data);
        
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- UPDATE / DELETE (Requieren buscar la fila primero) ---
    const row = await findRow(sheet, criteria);
    if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado.' }) };

    if (action === 'update') {
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
             const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             const parentId = row.get(parentKey);
             const allRows = await sheet.getRows(); // Recargar para tener frescura
             for (const r of allRows) {
                 if (r.get(parentKey) === parentId && r.get('id') !== row.get('id') && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); await r.save();
                 }
             }
        }
        // Actualizar campos
        Object.keys(data).forEach(key => { row.set(key, data[key]); });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (La Lógica Definitiva) ---
    if (action === 'delete') {
        // 1. Intentar borrar de Drive
        const fileId = row.get('fileId');
        const folderId = row.get('driveFolderId');
        const title = row.get('title') || row.get('name'); // Para log
        
        if (fileId) {
            try {
                await drive.files.delete({ fileId: fileId, supportsAllDrives: true });
                console.log(`Archivo eliminado de Drive: ${fileId}`);
            } catch (e) {
                console.warn(`No se pudo borrar archivo Drive ${fileId} (puede que ya no exista):`, e.message);
            }
        }

        if ((sheetTitle === 'Projects' || sheetTitle === 'RentalItems') && folderId) {
             try {
                await drive.files.delete({ fileId: folderId, supportsAllDrives: true });
                console.log(`Carpeta eliminada de Drive: ${folderId}`);
            } catch (e) {
                console.warn(`No se pudo borrar carpeta Drive ${folderId}:`, e.message);
            }
        }

        // 2. BORRAR DE SHEETS (Siempre se ejecuta)
        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
