// functions/update-sheet-data.js
// v5.0 - CRUD + ELIMINACIÓN DE ARCHIVOS EN DRIVE
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

async function getDoc() {
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return { doc, auth: serviceAccountAuth };
}

async function findRow(sheet, criteria) {
  if (!criteria) throw new Error("Criteria requerido.");
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const key = Object.keys(criteria)[0];
  return rows.find(row => String(row.get(key)) === String(criteria[key]));
}

async function deleteDriveFile(fileId, auth) {
    if (!fileId) return;
    try {
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.delete({ fileId, supportsAllDrives: true });
        console.log(`Archivo Drive ${fileId} eliminado.`);
    } catch (e) {
        console.warn(`No se pudo borrar archivo Drive ${fileId}:`, e.message);
    }
}

// Función recursiva para borrar carpetas por nombre
async function deleteDriveFolderByName(folderName, parentFolderName, auth) {
    try {
        const drive = google.drive({ version: 'v3', auth });
        // 1. Buscar ID de carpeta raíz de assets
        const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
        
        // 2. Buscar la carpeta contenedora (Projects o Rentals)
        let parentId = rootId;
        if(parentFolderName) {
            const qParent = `mimeType='application/vnd.google-apps.folder' and name='${parentFolderName}' and '${rootId}' in parents and trashed = false`;
            const resParent = await drive.files.list({ q: qParent, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
            if(resParent.data.files.length > 0) parentId = resParent.data.files[0].id;
            else return; // No existe la categoría, no hay nada que borrar
        }

        // 3. Buscar la carpeta del proyecto/item
        const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed = false`;
        const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        
        if (res.data.files.length > 0) {
            const folderId = res.data.files[0].id;
            await drive.files.delete({ fileId: folderId, supportsAllDrives: true });
            console.log(`Carpeta Drive ${folderName} eliminada.`);
        }
    } catch (e) {
        console.warn(`Error borrando carpeta ${folderName}:`, e.message);
    }
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { sheet: sheetTitle, action, data, criteria } = JSON.parse(event.body);
    const { doc, auth } = await getDoc(); // Usamos AUTH del robot para borrar (tiene permisos de Content Manager)
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: 'Hoja no encontrada.' }) };
    
    await sheet.loadHeaderRow();

    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        
        // Lógica Portada
        if (sheetTitle === 'ProjectImages' && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           for (const r of rows) { if (r.get('projectId') === data.projectId && r.get('isCover') === 'Si') { r.set('isCover', 'No'); await r.save(); } }
        }
        const newRow = await sheet.addRow(data);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    if (action === 'update') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: 'No encontrado' };
        
        // Renombrado de carpetas (Lógica avanzada: Si cambia título, habría que mover carpeta. Por simplicidad y seguridad, en v5 no renombramos carpetas automáticamente para evitar desconexiones, pero actualizamos el Sheet).
        
        Object.keys(data).forEach(k => { if (sheet.headerValues.includes(k)) row.set(k, data[k]); });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    if (action === 'delete') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: 'No encontrado' };

        // 1. Borrar Archivo Físico (Si es una tabla de imágenes)
        // Asumimos que la columna que guarda el ID de drive se llama 'fileId' o lo extraemos de la URL
        let fileIdToDelete = null;
        
        // Si tenemos un campo explícito 'fileId' (recomendado agregar en el futuro), úsalo.
        // Si no, intentamos extraerlo de imageUrl si es de google drive.
        const imgUrl = row.get('imageUrl');
        if (imgUrl && imgUrl.includes('drive.google.com')) {
            const match = imgUrl.match(/id=([a-zA-Z0-9_-]+)/);
            if (match) fileIdToDelete = match[1];
        }

        if (fileIdToDelete) {
            await deleteDriveFile(fileIdToDelete, auth);
        }

        // 2. Borrar Carpeta de Proyecto/Equipo (Si es tabla Projects o RentalItems)
        if (sheetTitle === 'Projects') {
            const title = row.get('title');
            await deleteDriveFolderByName(title, 'Projects', auth);
        }
        if (sheetTitle === 'RentalItems') {
            const name = row.get('name');
            await deleteDriveFolderByName(name, 'Rentals', auth);
        }

        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, error: 'Acción desconocida' };

  } catch (error) {
    console.error('Sheet Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
