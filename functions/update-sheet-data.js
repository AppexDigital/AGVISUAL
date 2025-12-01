// functions/update-sheet-data.js
// v15.0 - VERSIÓN DEFINITIVA Y ROBUSTA
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

async function findRow(sheet, criteria) {
    if (!criteria) return null;
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const key = Object.keys(criteria)[0];
    // Comparación laxa (String) para evitar errores de tipo
    return rows.find(row => String(row.get(key)) === String(criteria[key]));
}

exports.handler = async (event, context) => {
  // 1. Seguridad: Validar Token
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { sheet: sheetTitle, action, data, criteria } = body;

    const { doc, drive } = await getServices();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: `Hoja ${sheetTitle} no encontrada` }) };
    
    await sheet.loadHeaderRow();

    // --- ADD (Crear) ---
    if (action === 'add') {
        if (!data.id && sheetTitle !== 'BlockedDates') {
            data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        }

        // Lógica de "Portada Única": Si esta es portada, desmarcar las otras del mismo grupo
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
           const updates = [];
           for (const r of rows) { 
               if (r.get(parentKey) === data[parentKey] && r.get('isCover') === 'Si') { 
                   r.set('isCover', 'No'); 
                   updates.push(r.save());
               } 
           }
           await Promise.all(updates);
        }

        await sheet.addRow(data);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- BÚSQUEDA PARA UPDATE/DELETE ---
    const row = await findRow(sheet, criteria);
    if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado.' }) };

    // --- UPDATE (Actualizar) ---
    if (action === 'update') {
        // Lógica de "Portada Única" al editar
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
             const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             const parentId = row.get(parentKey);
             const allRows = await sheet.getRows(); 
             const updates = [];
             for (const r of allRows) {
                 // Desmarcar otros que sean del mismo padre y sean portada
                 if (r.get(parentKey) === parentId && String(r.get('id')) !== String(row.get('id')) && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); 
                     updates.push(r.save());
                 }
             }
             await Promise.all(updates);
        }
        
        // Actualizar campos
        Object.keys(data).forEach(key => { row.set(key, data[key]); });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (Eliminar) ---
    if (action === 'delete') {
        const fileId = row.get('fileId');
        const folderId = row.get('driveFolderId');
        
        // A. Borrar archivo individual (Si es una imagen)
        if (fileId) {
            try {
                await drive.files.delete({ fileId: fileId, supportsAllDrives: true });
                console.log(`Archivo eliminado de Drive: ${fileId}`);
            } catch (e) {
                console.warn(`Drive File Delete Warning: ${e.message}`);
            }
        }

        // B. Borrar carpeta completa (Si es Proyecto o Item con carpeta)
        if ((sheetTitle === 'Projects' || sheetTitle === 'RentalItems') && folderId) {
             try {
                await drive.files.delete({ fileId: folderId, supportsAllDrives: true });
                console.log(`Carpeta eliminada de Drive: ${folderId}`);
            } catch (e) {
                console.warn(`Drive Folder Delete Warning: ${e.message}`);
            }
        }

        // C. Borrar registro en Sheet (Siempre)
        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
