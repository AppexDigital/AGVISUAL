// functions/update-sheet-data.js
// v6.0 - ELIMINACIÓN REAL EN DRIVE (Cascade Delete)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

// Helper: Autenticación Robusta (Service Account)
async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  
  const drive = google.drive({ version: 'v3', auth });
  
  return { doc, drive };
}

// Helper: Encontrar Fila en Sheet
async function findRow(sheet, criteria) {
  if (!criteria) throw new Error("Criteria requerido.");
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const key = Object.keys(criteria)[0];
  return rows.find(row => String(row.get(key)) === String(criteria[key]));
}

// Helper: Extraer ID de archivo desde cualquier URL de Drive
function extractFileId(url) {
    if (!url) return null;
    // Patrones comunes: id=XYZ, /d/XYZ/, /file/d/XYZ
    const match1 = url.match(/id=([a-zA-Z0-9_-]+)/);
    if (match1) return match1[1];
    const match2 = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match2) return match2[1];
    return null;
}

// ACCIÓN 1: Borrar Archivo Individual (Imagen)
async function deleteDriveFile(drive, fileUrl) {
    const fileId = extractFileId(fileUrl);
    if (!fileId) return;
    try {
        await drive.files.delete({ fileId, supportsAllDrives: true });
        console.log(`[Drive] Archivo eliminado: ${fileId}`);
    } catch (e) {
        console.warn(`[Drive] No se pudo borrar archivo ${fileId}:`, e.message);
    }
}

// ACCIÓN 2: Borrar Carpeta de Proyecto (Navegación Jerárquica)
async function deleteProjectFolder(drive, folderName, categorySubfolder) {
    try {
        const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
        
        // 1. Buscar la carpeta de Categoría (ej: 'Projects' o 'Rentals') dentro de la Raíz
        const qCat = `mimeType='application/vnd.google-apps.folder' and name='${categorySubfolder}' and '${rootId}' in parents and trashed = false`;
        const resCat = await drive.files.list({ q: qCat, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        
        if (resCat.data.files.length === 0) return; // No existe la categoría
        const categoryId = resCat.data.files[0].id;

        // 2. Buscar la carpeta del Proyecto Específico dentro de la Categoría
        const qProj = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${categoryId}' in parents and trashed = false`;
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

    // --- LOGICA DE ACCIONES ---

    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        // Lógica de "Portada Única"
        if (sheetTitle === 'ProjectImages' && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           for (const r of rows) { 
               if (r.get('projectId') === data.projectId && r.get('isCover') === 'Si') { 
                   r.set('isCover', 'No'); await r.save(); 
               } 
           }
        }
        const newRow = await sheet.addRow(data);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    if (action === 'update') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };
        
        Object.keys(data).forEach(k => { 
            if (sheet.headerValues.includes(k)) row.set(k, data[k]); 
        });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    if (action === 'delete') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        // --- ELIMINACIÓN EN DRIVE ---
        
        // Caso A: Borrar una imagen específica (de ProjectImages o RentalItemImages)
        const imgUrl = row.get('imageUrl');
        if (imgUrl) {
            await deleteDriveFile(drive, imgUrl);
        }

        // Caso B: Borrar un Proyecto entero (Hoja Projects)
        if (sheetTitle === 'Projects') {
            const title = row.get('title');
            if (title) await deleteProjectFolder(drive, title, 'Projects');
            
            // También deberíamos borrar las filas hijas en ProjectImages (opcional pero recomendado para limpiar Sheet)
            // Esto se maneja mejor desde el frontend llamando deletes en cascada, o aquí si se prefiere lógica server-side.
            // Por seguridad y simplicidad, mantenemos la lógica frontend de "borrar hijos primero".
        }

        // Caso C: Borrar un Equipo de Alquiler (Hoja RentalItems)
        if (sheetTitle === 'RentalItems') {
            const name = row.get('name');
            if (name) await deleteProjectFolder(drive, name, 'Rentals');
        }

        // Finalmente, borrar la fila del Sheet
        await row.delete();
        
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Sheet Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
