const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

exports.handler = async (event, context) => {
    console.log("Iniciando Mantenimiento Seguro...");
    let logBuffer = []; // Para acumular el reporte

    try {
        // 1. Verificación de Seguridad de la Llave
        if (!process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
            throw new Error("Faltan las credenciales en las variables de entorno.");
        }

        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        const drive = google.drive({ version: 'v3', auth });

        await doc.loadInfo();
        logBuffer.push("Conexión con Sheets exitosa.");

        // 2. Barrido Rápido de Drive (Solo obtenemos IDs y Links)
        const freshLinksMap = new Map();
        let pageToken = null;
        let driveCount = 0;
        
        try {
            do {
                const res = await drive.files.list({
                    q: "trashed = false", // Sin filtros complejos para velocidad
                    fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
                    pageSize: 1000,
                    pageToken: pageToken,
                    supportsAllDrives: true, includeItemsFromAllDrives: true
                });
                
                if (res.data.files) {
                    res.data.files.forEach(f => {
                        let link = f.webContentLink; // Prioridad descarga
                        if (!link && f.thumbnailLink) {
                            // Fallback a imagen original
                            link = f.thumbnailLink.split('=')[0] + '=s0';
                        }
                        if (link) {
                            link = link.replace(/^http:\/\//i, 'https://');
                            freshLinksMap.set(f.id, link);
                        }
                    });
                    driveCount += res.data.files.length;
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
            logBuffer.push(`Drive escaneado: ${driveCount} archivos encontrados.`);
        } catch (e) {
            throw new Error(`Fallo leyendo Drive: ${e.message}`);
        }

        // 3. Actualización Quirúrgica (Fila por Fila)
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
        let totalUpdates = 0;
        const MAX_UPDATES_PER_RUN = 40; // Límite de seguridad para evitar Timeout (Netlify 10s)

        for (const title of targetSheets) {
            if (totalUpdates >= MAX_UPDATES_PER_RUN) {
                logBuffer.push(`Límite de seguridad alcanzado. Pausando resto de actualizaciones para la próxima ejecución.`);
                break;
            }

            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            await sheet.loadHeaderRow(); 
            const rows = await sheet.getRows(); // Carga ligera (objetos)
            
            // Detectar nombres de columnas reales
            const h = sheet.headerValues;
            const keyId = h.includes('fileId') ? 'fileId' : null;
            const keyUrl = h.includes('imageUrl') ? 'imageUrl' : (h.includes('logoUrl') ? 'logoUrl' : null);

            if (!keyId || !keyUrl) {
                logBuffer.push(`[${title}] Omitido: No se encontraron columnas 'fileId' o URL.`);
                continue;
            }

            let sheetUpdates = 0;

            // Recorremos filas
            for (const row of rows) {
                // Si alcanzamos el límite global, paramos de inmediato
                if (totalUpdates >= MAX_UPDATES_PER_RUN) break;

                const fileId = row.get(keyId);
                const currentUrl = row.get(keyUrl);

                if (fileId && typeof fileId === 'string') {
                    const cleanId = fileId.trim();
                    if (freshLinksMap.has(cleanId)) {
                        const freshUrl = freshLinksMap.get(cleanId);
                        
                        // Solo "gastamos tiempo" guardando si el link es diferente
                        if (currentUrl !== freshUrl) {
                            row.set(keyUrl, freshUrl);
                            await row.save(); // Guardado individual seguro
                            sheetUpdates++;
                            totalUpdates++;
                        }
                    }
                }
            }
            if (sheetUpdates > 0) logBuffer.push(`[${title}] ${sheetUpdates} filas corregidas.`);
        }

        return { 
            statusCode: 200, 
            body: `Mantenimiento Finalizado.\n\nLOGS:\n${logBuffer.join('\n')}` 
        };

    } catch (error) {
        console.error("Fatal Error:", error);
        return { 
            statusCode: 500, 
            body: `ERROR FATAL:\n${error.message}\n\nLOGS PARCIALES:\n${logBuffer.join('\n')}` 
        };
    }
};
