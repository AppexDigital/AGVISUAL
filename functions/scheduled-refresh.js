const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

exports.handler = async (event, context) => {
    // CRONÓMETRO DE SEGURIDAD (8 segundos)
    const TIME_LIMIT = 8000;
    const startTime = Date.now();
    let logs = [];

    // Esta línea permite forzar la ejecución desde el navegador
    console.log(">>> INICIANDO ROBOT DE MANTENIMIENTO...");

    try {
        // 1. Autenticación (Modo Compatible V4)
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        
        // En V4 pasamos el auth al cargar info, no en el constructor
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
        const drive = google.drive({ version: 'v3', auth });

        await doc.useServiceAccountAuth({
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        });
        
        await doc.loadInfo();
        logs.push("Conexión Sheets OK.");

        // 2. Barrido Rápido de Drive
        const freshLinksMap = new Map();
        let pageToken = null;
        
        try {
            do {
                if (Date.now() - startTime > TIME_LIMIT) break;

                const res = await drive.files.list({
                    q: "trashed = false and mimeType contains 'image/'",
                    fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
                    pageSize: 1000,
                    pageToken: pageToken,
                    supportsAllDrives: true, includeItemsFromAllDrives: true
                });
                
                if (res.data.files) {
                    res.data.files.forEach(f => {
                        // Estrategia Robusta: =s0
                        let link = f.webContentLink;
                        if (!link && f.thumbnailLink) {
                            link = f.thumbnailLink.split('=')[0] + '=s0';
                        }
                        if (link) {
                            freshLinksMap.set(f.id, link.replace(/^http:\/\//i, 'https://'));
                        }
                    });
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
            logs.push(`Drive escaneado: ${freshLinksMap.size} archivos.`);
        } catch (e) {
            logs.push(`Error Drive: ${e.message}`);
        }

        // 3. Actualización Sheets
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
        let changesCount = 0;

        for (const title of targetSheets) {
            if (Date.now() - startTime > TIME_LIMIT) break;

            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            // En V4 getRows es simple
            const rows = await sheet.getRows();
            
            // Mapeo manual de columnas porque V4 no expone headerValues fácil
            // Asumimos que existen. Si no, fallará suavemente.
            let updatedSheet = 0;

            for (const row of rows) {
                if (Date.now() - startTime > TIME_LIMIT) break;

                // En V4 accedemos directo a la propiedad
                const fileId = row.fileId; 
                
                // Determinamos cuál columna de URL usar
                const urlKey = row.imageUrl !== undefined ? 'imageUrl' : (row.logoUrl !== undefined ? 'logoUrl' : null);

                if (fileId && urlKey && freshLinksMap.has(fileId.trim())) {
                    const newLink = freshLinksMap.get(fileId.trim());
                    if (row[urlKey] !== newLink) {
                        row[urlKey] = newLink;
                        await row.save(); // Guardado V4
                        updatedSheet++;
                        changesCount++;
                    }
                }
            }
            if(updatedSheet > 0) logs.push(`[${title}] ${updatedSheet} corregidos.`);
        }

        return {
            statusCode: 200,
            body: `MANTENIMIENTO FINALIZADO.\nCambios: ${changesCount}\nLogs: ${logs.join(' | ')}`
        };

    } catch (error) {
        console.error("Error Fatal:", error);
        return { statusCode: 500, body: `Error: ${error.message}` };
    }
};
