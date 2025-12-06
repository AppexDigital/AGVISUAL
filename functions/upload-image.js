// functions/upload-image.js
// v10.0 - VERIFICACIÓN DE CARPETA REAL & ERROR TOLERANCE
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');

function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    try {
      const busboy = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] } });
      const fields = {};
      const files = {};
      const tmpdir = os.tmpdir();
      const writePromises = [];

      busboy.on('field', (n, v) => fields[n] = v);
      
      busboy.on('file', (n, file, info) => {
        const filepath = path.join(tmpdir, `up_${Date.now()}_${Math.random().toString(36).substring(7)}_${info.filename}`);
        const writeStream = fs.createWriteStream(filepath);
        
        const promise = new Promise((resStream, rejStream) => {
            file.pipe(writeStream)
                .on('error', rejStream)
                .on('finish', () => {
                    files[n] = { ...info, filepath };
                    resStream();
                });
        });
        writePromises.push(promise);
      });

      busboy.on('close', async () => {
          await Promise.all(writePromises);
          resolve({ fields, files });
      });
      
      busboy.on('error', reject);
      busboy.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary'));
    } catch (e) { reject(e); }
  });
}

async function getFolderByName(drive, parentId, folderName) {
    const safeName = folderName.replace(/'/g, "\\'");
    const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and '${parentId}' in parents and trashed = false`;
    const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    
    if (res.data.files.length > 0) return res.data.files[0].id;
    
    const newFolder = await drive.files.create({
        resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id', supportsAllDrives: true
    });
    return newFolder.data.id;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const userToken = event.headers.authorization?.split(' ')[1];
  if (!userToken) return { statusCode: 401, body: 'Unauthorized' };

  let tempFilePath = null;

  try {
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    
    const targetFolderId = fields.targetFolderId; 
    const folderName = fields.parentFolderName || 'General';
    const subFolderType = fields.targetSubfolder || 'Varios';

    if (!file) throw new Error('No se recibió ningún archivo.');
    tempFilePath = file.filepath;

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: userToken });
    const drive = google.drive({ version: 'v3', auth });

    const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
    const categoryFolderId = await getFolderByName(drive, rootId, subFolderType);
    
    let finalFolderId;

    // LÓGICA DE RECUPERACIÓN DE CARPETA (Anti-Error 404)
    if (targetFolderId && targetFolderId !== 'null' && targetFolderId !== 'undefined' && targetFolderId.trim() !== '') {
        try {
            // Verificamos si la carpeta REALMENTE existe
            await drive.files.get({ fileId: targetFolderId, fields: 'id' });
            finalFolderId = targetFolderId;
        } catch (e) {
            console.warn(`Carpeta ID ${targetFolderId} no encontrada (posiblemente borrada). Creando nueva...`);
            // Si falla, ignoramos el ID y buscamos/creamos por nombre
            finalFolderId = await getFolderByName(drive, categoryFolderId, folderName);
        }
    } else {
        finalFolderId = await getFolderByName(drive, categoryFolderId, folderName);
    }

    // Subir Archivo
    const res = await drive.files.create({
      resource: { name: file.filename, parents: [finalFolderId] },
      media: { mimeType: file.mimeType, body: fs.createReadStream(tempFilePath) },
      fields: 'id, thumbnailLink, webViewLink',
      supportsAllDrives: true
    });

    // Intentar hacer público (No fatal si falla)
    try {
        await drive.permissions.create({ fileId: res.data.id, requestBody: { role: 'reader', type: 'anyone' } });
    } catch (permError) {
        console.warn("Advertencia: No se pudo hacer público el archivo automáticamente.", permError.message);
    }


    // CÓDIGO NUEVO (Estable para Web)
    
    // Utilizamos el thumbnailLink oficial de Google.
    // Estos enlaces vienen de 'googleusercontent.com' y están optimizados para web,
    // por lo que NO tienen problemas de CORS (se ven en la etiqueta <img>).
    // Por defecto vienen pequeños (=s220). Lo reemplazamos por =s1600 (1600px de ancho),
    // que es una excelente calidad para web y es un tamaño estándar que NO caduca.
    
    let imgUrl = res.data.webViewLink; // Fallback por si acaso

    if (res.data.thumbnailLink) {
        // Usamos una expresión regular para encontrar cualquier parámetro de tamaño (=s...)
        // y reemplazarlo de forma segura por =s1600.
        imgUrl = res.data.thumbnailLink.replace(/=s\d+.*$/, '=s1600');
    }
    
    return {
        statusCode: 200,
        body: JSON.stringify({ 
            message: 'OK', 
            fileId: res.data.id,          // Frontend espera 'fileId'
            imageUrl: imgUrl,             // Frontend espera 'imageUrl'
            driveFolderId: finalFolderId  // Frontend espera 'driveFolderId' (para crear subcarpetas futuras)
        })
    };

  } catch (e) {
    console.error("Upload Error:", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch(e) {}
    }
  }
};
