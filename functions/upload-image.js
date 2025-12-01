// functions/upload-image.js
// v9.0 - ESCRITURA EN DISCO GARANTIZADA (Anti-Race Condition)
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');

// Helper: Parsea el formulario y GARANTIZA que el archivo se escriba completamente en disco
function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    try {
      const busboy = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] } });
      const fields = {};
      const files = {};
      const tmpdir = os.tmpdir();
      const writePromises = []; // Array para controlar las escrituras

      busboy.on('field', (n, v) => fields[n] = v);
      
      busboy.on('file', (n, file, info) => {
        const filepath = path.join(tmpdir, `up_${Date.now()}_${Math.random().toString(36).substring(7)}_${info.filename}`);
        const writeStream = fs.createWriteStream(filepath);
        
        // Creamos una promesa que solo se resuelve cuando el stream TERMINA de escribir
        const promise = new Promise((resStream, rejStream) => {
            file.pipe(writeStream)
                .on('error', rejStream)
                .on('finish', () => {
                    files[n] = { ...info, filepath };
                    resStream(); // ¡Ahora sí es seguro!
                });
        });
        writePromises.push(promise);
      });

      busboy.on('close', async () => {
          // Esperamos a que TODAS las escrituras en disco terminen
          await Promise.all(writePromises);
          resolve({ fields, files });
      });
      
      busboy.on('error', reject);
      busboy.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary'));
    } catch (e) { reject(e); }
  });
}

// Helper: Obtiene carpeta por NOMBRE (o la crea)
async function getFolderByName(drive, parentId, folderName) {
    const safeName = folderName.replace(/'/g, "\\'");
    const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and '${parentId}' in parents and trashed = false`;
    
    const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    
    if (res.data.files.length > 0) {
        return res.data.files[0].id;
    } else {
        const newFolder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id', supportsAllDrives: true
        });
        return newFolder.data.id;
    }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const userToken = event.headers.authorization?.split(' ')[1];
  if (!userToken) return { statusCode: 401, body: 'Unauthorized' };

  let tempFilePath = null;

  try {
    // 1. Parsear y esperar escritura en disco
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    
    // Datos del Frontend
    const targetFolderId = fields.targetFolderId; 
    const folderName = fields.parentFolderName || 'General';
    const subFolderType = fields.targetSubfolder || 'Varios';

    if (!file || !file.filepath) throw new Error('Error crítico: El archivo no se pudo guardar en el servidor temporal.');
    tempFilePath = file.filepath;

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: userToken });
    const drive = google.drive({ version: 'v3', auth });

    const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
    if (!rootId) throw new Error('Configuración faltante: GOOGLE_DRIVE_ASSET_FOLDER_ID no está definido.');

    // 2. Gestionar Carpetas
    const categoryFolderId = await getFolderByName(drive, rootId, subFolderType);
    let finalFolderId;

    if (targetFolderId && targetFolderId !== 'null' && targetFolderId !== 'undefined') {
        try {
            // Validar que el ID exista realmente
            await drive.files.get({ fileId: targetFolderId, fields: 'id', supportsAllDrives: true });
            finalFolderId = targetFolderId;
        } catch (e) {
            console.warn("ID de carpeta inválido o inaccesible, usando nombre...");
            finalFolderId = await getFolderByName(drive, categoryFolderId, folderName);
        }
    } else {
        finalFolderId = await getFolderByName(drive, categoryFolderId, folderName);
    }

    // 3. Subir a Google Drive (Ahora es seguro leer el archivo)
    const res = await drive.files.create({
      resource: { name: file.filename, parents: [finalFolderId] },
      media: { mimeType: file.mimeType, body: fs.createReadStream(tempFilePath) },
      fields: 'id, thumbnailLink, webViewLink',
      supportsAllDrives: true
    });

    // 4. Permisos y Respuesta
    await drive.permissions.create({ fileId: res.data.id, requestBody: { role: 'reader', type: 'anyone' } });
    let imgUrl = res.data.thumbnailLink ? res.data.thumbnailLink.replace('=s220', '=s3000') : res.data.webViewLink;

    return {
      statusCode: 200,
      body: JSON.stringify({ 
          message: 'OK', 
          fileId: res.data.id, 
          imageUrl: imgUrl, 
          driveFolderId: finalFolderId
      })
    };

  } catch (e) {
    console.error("Upload Error Stack:", e.stack);
    return { statusCode: 500, body: JSON.stringify({ error: `Error en subida: ${e.message}` }) };
  } finally {
    // Limpieza siempre
    if (tempFilePath && fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch(e) { console.error("Error limpiando temp:", e); }
    }
  }
};
