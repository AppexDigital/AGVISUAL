const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

exports.handler = async (event, context) => {
    // 1. INICIO DEL CRONÓMETRO (Límite 9 segundos para no llegar al Timeout de 10s)
    const TIME_LIMIT = 9000; 
    const startTime = Date.now();
    
    console.log("Iniciando Mantenimiento Time-Aware...");
    let logs = [];

    // Helper para chequear tiempo
    const checkTime = () => {
        if (Date.now() - startTime > TIME_LIMIT) {
            throw new Error("TIME_LIMIT_REACHED");
        }
    };

    try {
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        const drive = google.drive({ version: 'v3', auth });

        await doc.loadInfo();
        checkTime(); // Chequeo 1

        // 2. BARRIDO RÁPIDO DE DRIVE (Optinizado)
        const freshLinksMap = new Map();
        let pageToken = null;
        
        // Solo traemos lo necesario para ser veloces
        try {
            do {
                checkTime(); // Chequeo dentro del bucle
                
                const res = await drive.files.list({
                    q: "trashed = false", // Sin filtros complejos
                    fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
                    pageSize: 1000,
                    pageToken: pageToken,
                    supportsAllDrives: true, includeItemsFromAllDrives: true
                });
                
                if (res.data.files) {
                    res.data.files.forEach(f => {
                        let link = f.webContentLink || (f.thumbnailLink ? f.thumbnailLink.split('=')[0] + '=s0' : null);
                        if (link) {
                            freshLinksMap.set(f.id, link.replace(/^http:\/\//i, 'https://'));
                        }
                    });
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
        } catch (e) {
            if (e.message === "TIME_LIMIT_REACHED") {
                console.log("Tiempo agotado leyendo Drive. Continuando con lo que tenemos...");
            } else {
                throw e;
            }
        }

        logs.push(`Drive Map: ${freshLinksMap.size} archivos.`);

        // 3. ACTUALIZACIÓN QUIRÚRGICA DE SHEETS
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];

        for (const title of targetSheets) {
            // Si ya no hay tiempo, paramos antes de empezar otra hoja
            if (Date.now() - startTime > TIME_LIMIT) break;

            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            // Usamos getRows (Más ligero que loadCells)
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows(); 
            
            const h = sheet.headerValues;
            const keyId = h.includes('fileId') ? 'fileId' : null;
            const keyUrl = h.includes('imageUrl') ? 'imageUrl' : (h.includes('logoUrl') ? 'logoUrl' : null);

            if (!keyId || !keyUrl) continue;

            let sheetUpdates = 0;

            for (const row of rows) {
                // Chequeo Crítico por Fila
                if (Date.now() - startTime > TIME_LIMIT) {
                    logs.push("Tiempo agotado. Guardando progreso parcial...");
                    break; 
                }

                const fileId = row.get(keyId);
                const currentUrl = row.get(keyUrl);

                if (fileId && typeof fileId === 'string') {
                    const cleanId = fileId.trim();
                    if (freshLinksMap.has(cleanId)) {
                        const newLink = freshLinksMap.get(cleanId);
                        if (currentUrl !== newLink) {
                            row.set(keyUrl, newLink);
                            await row.save(); // Guardado individual (lento pero seguro)
                            sheetUpdates++;
                        }
                    }
                }
            }
            logs.push(`[${title}] ${sheetUpdates} filas actualizadas.`);
        }

        return { statusCode: 200, body: `Ejecución Finalizada.\n${logs.join('\n')}` };

    } catch (error) {
        // Si el error fue por tiempo, lo consideramos un "Éxito Parcial" (200 OK)
        if (error.message === "TIME_LIMIT_REACHED") {
            return { statusCode: 200, body: `Timeout Controlado.\n${logs.join('\n')}` };
        }
        console.error("Fatal Error:", error);
        return { statusCode: 500, body: error.message };
    }
};
