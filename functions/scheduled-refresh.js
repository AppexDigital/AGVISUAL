const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

// Si usas Node 18+ en Netlify, 'fetch' es nativo. Si usas versiones viejas, requeriría 'node-fetch'.
// Netlify por defecto hoy usa Node 18 o 20, así que esto funciona directo.

exports.handler = async (event, context) => {
    const BATCH_SIZE = 200; // Procesamos 200 fotos por viaje (seguro y rápido)
    const MAX_LOOPS = 15;   // Seguridad: Máximo 15 relevos seguidos (3000 fotos aprox) para evitar bucles infinitos.

    // Construir la URL propia para el auto-llamado
    const siteUrl = process.env.URL || 'https://agvisual.netlify.app'; // Netlify suele dar esta variable
    const functionUrl = `${siteUrl}/.netlify/functions/scheduled-refresh`;

    let logs = [];
    logs.push(`Inicio de Relevo. Batch: ${BATCH_SIZE}`);

    try {
        // 1. Conexión
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        const drive = google.drive({ version: 'v3', auth });

        // 2. Leer Estado del Sistema (Memoria)
        // No cargamos todo el doc, solo la hoja de estado para ser veloces
        const stateSheet = doc.sheetsByTitle['_SystemState'];
        if (!stateSheet) throw new Error("Falta hoja _SystemState");
        
        await stateSheet.loadHeaderRow();
        const stateRows = await stateSheet.getRows();
        
        const tokenRow = stateRows.find(r => r.get('key') === 'drivePageToken');
        const safetyRow = stateRows.find(r => r.get('key') === 'loopSafetyCount');

        if (!tokenRow || !safetyRow) throw new Error("Faltan filas de configuración en _SystemState");

        const currentToken = tokenRow.get('value') || null;
        let currentLoop = parseInt(safetyRow.get('value') || '0');

        // CHECK DE SEGURIDAD
        if (currentLoop >= MAX_LOOPS) {
            // Si llegamos al límite, reseteamos y paramos por hoy.
            safetyRow.set('value', '0');
            tokenRow.set('value', '');
            await stateSheet.saveUpdatedCells();
            return { statusCode: 200, body: "Límite de seguridad alcanzado. El ciclo se reiniciará en la próxima ejecución programada." };
        }

        // 3. Obtener Lote de Drive
        const driveRes = await drive.files.list({
            q: "trashed = false and mimeType contains 'image/'",
            fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
            pageSize: BATCH_SIZE,
            pageToken: currentToken,
            supportsAllDrives: true, includeItemsFromAllDrives: true
        });

        const files = driveRes.data.files || [];
        const nextToken = driveRes.data.nextPageToken;
        logs.push(`Drive: ${files.length} archivos obtenidos.`);

        if (files.length === 0) {
            // Fin del catálogo
            tokenRow.set('value', '');
            safetyRow.set('value', '0');
            await stateSheet.saveUpdatedCells();
            return { statusCode: 200, body: "Catálogo terminado. Sistema listo para reinicio." };
        }

        // Mapa de Links
        const freshLinksMap = new Map();
        files.forEach(f => {
            let link = f.webContentLink || (f.thumbnailLink ? f.thumbnailLink.split('=')[0] + '=s0' : null);
            if (link) freshLinksMap.set(f.id, link.replace(/^http:\/\//i, 'https://'));
        });

        // 4. Actualizar Excel (Solo cargamos info de hojas si hay algo que actualizar)
        if (freshLinksMap.size > 0) {
            await doc.loadInfo(); 
            const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
            
            for (const title of targetSheets) {
                const sheet = doc.sheetsByTitle[title];
                if (!sheet) continue;

                // Carga optimizada
                await sheet.loadHeaderRow();
                const rows = await sheet.getRows();
                
                const h = sheet.headerValues;
                const keyId = h.includes('fileId') ? 'fileId' : null;
                const keyUrl = h.includes('imageUrl') ? 'imageUrl' : (h.includes('logoUrl') ? 'logoUrl' : null);

                if (!keyId || !keyUrl) continue;

                let updates = 0;
                for (const row of rows) {
                    const fileId = row.get(keyId);
                    if (fileId && freshLinksMap.has(fileId.trim())) {
                        const newLink = freshLinksMap.get(fileId.trim());
                        if (row.get(keyUrl) !== newLink) {
                            row.set(keyUrl, newLink);
                            await row.save(); // Guardado atómico
                            updates++;
                        }
                    }
                }
                if (updates > 0) logs.push(`[${title}] ${updates} actualizados.`);
            }
        }

        // 5. PREPARAR EL RELEVO (Paso Crítico)
        if (nextToken) {
            // Guardamos estado para el siguiente corredor
            tokenRow.set('value', nextToken);
            safetyRow.set('value', (currentLoop + 1).toString());
            await stateSheet.saveUpdatedCells();

            logs.push(`Relevo preparado (Loop ${currentLoop + 1}). Disparando siguiente lote...`);

            // --- AUTO-DISPARO (FIRE AND FORGET) ---
            // Intentamos invocar la función de nuevo sin esperar respuesta para no consumir tiempo
            try {
                // Fetch asíncrono sin await (o con timeout muy corto) para liberar esta función
                fetch(functionUrl, { method: 'POST' }).catch(e => console.log("Trigger lanzado"));
            } catch (e) {
                console.log("Intento de auto-disparo realizado.");
            }
            
            return { 
                statusCode: 200, 
                body: `Lote completado. Continuando... \nLogs: ${logs.join(' | ')}` 
            };

        } else {
            // No hay nextToken, terminamos todo el catálogo
            tokenRow.set('value', '');
            safetyRow.set('value', '0');
            await stateSheet.saveUpdatedCells();
            return { statusCode: 200, body: "ACTUALIZACIÓN COMPLETA FINALIZADA." };
        }

    } catch (error) {
        console.error("Error Relevo:", error);
        return { statusCode: 500, body: error.message };
    }
};
