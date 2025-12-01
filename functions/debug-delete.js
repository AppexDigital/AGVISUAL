// functions/debug-delete.js
// HERRAMIENTA DE DIAGNÓSTICO FORENSE
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

// Reutilizamos la lógica exacta de tu sistema para ver si falla aquí
function findRealHeader(sheet, targetName) {
    const headers = sheet.headerValues;
    const target = targetName.toLowerCase().trim();
    return headers.find(h => h.toLowerCase().trim() === target);
}

function getSafeValue(row, sheet, targetColumnName) {
    const realHeader = findRealHeader(sheet, targetColumnName);
    if (!realHeader) return { found: false, headerUsed: null, value: null };
    return { found: true, headerUsed: realHeader, value: row.get(realHeader) };
}

exports.handler = async (event, context) => {
  try {
    // 1. Autenticación (Directa, saltamos validación de usuario para test rápido)
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    const drive = google.drive({ version: 'v3', auth });

    await doc.loadInfo();

    // 2. Obtener parámetros de la URL
    // Uso: /.netlify/functions/debug-delete?sheet=ProjectImages&id=ID_DE_LA_FILA
    const sheetTitle = event.queryStringParameters.sheet;
    const rowId = event.queryStringParameters.id;

    if (!sheetTitle || !rowId) {
        return { statusCode: 400, body: "Faltan parámetros: ?sheet=NOMBRE&id=ID_FILA" };
    }

    const report = {
        paso_1_sheet: "Iniciado",
        paso_2_fila: "Pendiente",
        paso_3_drive_datos: "Pendiente",
        paso_4_intento_borrado: "Pendiente",
        resultado_final: "En proceso"
    };

    // 3. Buscar en Sheet
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) throw new Error(`Hoja ${sheetTitle} no encontrada`);
    
    await sheet.loadHeaderRow();
    report.paso_1_sheet = `Hoja encontrada. Columnas: ${sheet.headerValues.join(', ')}`;

    const rows = await sheet.getRows();
    // Buscamos la fila usando la misma lógica laxa
    const realIdHeader = findRealHeader(sheet, 'id');
    const row = rows.find(r => String(r.get(realIdHeader)) === String(rowId));

    if (!row) {
        report.resultado_final = "FALLO: Fila no encontrada en Sheet";
        return { statusCode: 200, body: JSON.stringify(report, null, 2) };
    }
    report.paso_2_fila = "Fila encontrada";

    // 4. Extraer IDs de Drive
    const fileInfo = getSafeValue(row, sheet, 'fileId');
    const folderInfo = getSafeValue(row, sheet, 'driveFolderId');

    report.datos_en_fila = {
        fileId_detectado: fileInfo,
        folderId_detectado: folderInfo
    };

    // 5. Prueba de Fuego en Drive (Intentar borrar lo que se encuentre)
    const targetId = fileInfo.value || folderInfo.value;

    if (!targetId) {
        report.paso_3_drive_datos = "No se encontró ningún ID de Drive en esta fila.";
        report.resultado_final = "ABORTADO: Nada que borrar.";
    } else {
        report.paso_3_drive_datos = `Intentando borrar ID: ${targetId}`;
        
        try {
            // Verificamos si existe y qué es
            const meta = await drive.files.get({ fileId: targetId, fields: 'id, name, mimeType, owners', supportsAllDrives: true });
            report.meta_archivo_drive = meta.data;

            // INTENTO DE BORRADO REAL
            await drive.files.delete({ fileId: targetId, supportsAllDrives: true });
            report.paso_4_intento_borrado = "ÉXITO: Drive respondió 204 Deleted.";
            report.resultado_final = "El archivo existía y fue borrado correctamente por la API.";

        } catch (driveError) {
            report.paso_4_intento_borrado = `ERROR DRIVE: ${driveError.message}`;
            report.error_completo = driveError;
            
            if (driveError.code === 404) {
                report.resultado_final = "El archivo ya no existe en Drive (o el ID es incorrecto).";
            } else if (driveError.code === 403) {
                report.resultado_final = "PERMISOS INSUFICIENTES. El Service Account no es dueño o no tiene permiso de borrar.";
            }
        }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report, null, 2)
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message, stack: error.stack }) };
  }
};
