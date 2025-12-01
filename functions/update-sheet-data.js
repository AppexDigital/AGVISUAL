// functions/update-sheet-data.js
// v7.0 - ELIMINACIÓN INFALIBLE (ID EXPLÍCITO)
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
  if (!criteria) throw new Error("Criteria requerido.");
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const key = Object.keys(criteria)[0];
  return rows.find(row => String(row.get(key)) === String(criteria[key]));
}

async function findRows(sheet, criteria) {
    if (!criteria) return [];
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const key = Object.keys(criteria)[0];
    return rows.filter(row => String(row.get(key)) === String(criteria[key]));
}

async function deleteDriveFile(drive, fileId) {
    if (!fileId) return;
    try {
        await drive.files.delete({ fileId, supportsAllDrives: true });
        console.log(`[Drive] Archivo eliminado: ${fileId}`);
    } catch (e) {
        console.warn(`[Drive] Error borrando archivo ${fileId}:`, e.message);
    }
}

async function deleteDriveFolderByName(drive, folderName, categorySubfolder) {
    try {
        const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
        // 1. Buscar carpeta de Categoría (Projects/Rentals)
        const qCat = `mimeType='application/vnd.google-apps.folder' and name='${categorySubfolder}' and '${rootId}' in parents and trashed = false`;
        const resCat = await drive.files.list({ q: qCat, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        if (resCat.data.files.length === 0) return; 
        
        // 2. Buscar carpeta del Proyecto dentro de la Categoría
        const parentId = resCat.data.files[0].id;
        const qProj = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed = false`;
        const resProj = await drive.files.list({ q: qProj, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });

        if (resProj.data.files.length > 0) {
            const folderId = resProj.data.files[0].id;
            await drive.files.delete({ fileId: folderId, supportsAllDrives: true });
            console.log(`[Drive] Carpeta eliminada: ${folderName} (${folderId})`);
        }
    } catch (e) {
        console.warn(`[Drive] Error borrando carpeta ${folderName}:`, e.message);
    }
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { sheet: sheetTitle, action, data, criteria } = JSON.parse(event.body);
    const { doc, drive } = await getServices();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: 'Hoja no encontrada.' }) };
    await sheet.loadHeaderRow();

    // --- ADD ---
    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        if (sheetTitle === 'ProjectImages' && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           for (const r of rows) { if (r.get('projectId') === data.projectId && r.get('isCover') === 'Si') { r.set('isCover', 'No'); await r.save(); } }
        }
        const newRow = await sheet.addRow(data);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- UPDATE ---
    if (action === 'update') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: 'No encontrado' };
        
        // Lógica especial para Portada Única en actualización
        if (sheetTitle === 'ProjectImages' && data.isCover === 'Si') {
            const allRows = await findRows(sheet, { projectId: row.get('projectId') });
            for (const r of allRows) {
                if (r.get('id') !== row.get('id') && r.get('isCover') === 'Si') {
                    r.set('isCover', 'No'); await r.save();
                }
            }
        }

        Object.keys(data).forEach(k => { if (sheet.headerValues.includes(k)) row.set(k, data[k]); });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE ---
    if (action === 'delete') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        // 1. Borrar Archivo de Drive (Si tiene fileId explícito)
        const fileId = row.get('fileId'); // <--- LA CLAVE DEL ÉXITO
        if (fileId) {
            await deleteDriveFile(drive, fileId);
        }

        // 2. Borrar Carpeta (Si es Proyecto o Equipo)
        if (sheetTitle === 'Projects') {
            const title = row.get('title');
            if (title) await deleteDriveFolderByName(drive, title, 'Projects');
        }
        if (sheetTitle === 'RentalItems') {
            const name = row.get('name');
            if (name) await deleteDriveFolderByName(drive, name, 'Rentals');
        }

        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Sheet Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
