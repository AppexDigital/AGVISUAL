// functions/get-website-data.js
// v10.0 - Read-time Hydration (Links Frescos)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  const drive = google.drive({ version: 'v3', auth });
  return { doc, drive };
}

function rowsToObjects(sheet, rows) {
  if (!rows || rows.length === 0) return [];
  const headers = sheet.headerValues || [];
  return rows.map(row => {
    const obj = {};
    headers.forEach(header => {
      obj[header] = row.get(header) !== undefined && row.get(header) !== null ? row.get(header) : '';
    });
    return obj;
  });
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { doc, drive } = await getServices();
    
    // Lista de todas las hojas necesarias
    const sheetTitles = [
        'Settings', 'About', 'Videos', 'ClientLogos', 
        'Projects', 'ProjectImages', 
        'Services', 'ServiceContentBlocks', 'ServiceImages', 
        'RentalCategories', 'RentalItems', 'RentalItemImages'
    ];

    const sheetPromises = sheetTitles.map(async (title) => {
      const sheet = doc.sheetsByTitle[title];
      if (!sheet) return { title, data: [] };
      await sheet.loadHeaderRow();
      const rows = await sheet.getRows();
      return { title, data: rowsToObjects(sheet, rows) };
    });

    const results = await Promise.all(sheetPromises);
    const sheetsData = {};
    results.forEach(res => sheetsData[res.title] = res.data);

    // --- LÓGICA DE HIDRATACIÓN (READ-TIME HYDRATION) ---
    try {
        // Pedimos links frescos a Drive
        const driveRes = await drive.files.list({
            q: "mimeType contains 'image/' and trashed = false",
            fields: 'files(id, thumbnailLink)',
            pageSize: 1000,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });

        const freshLinksMap = new Map();
        if (driveRes.data.files) {
            driveRes.data.files.forEach(f => {
                if (f.thumbnailLink) {
                    freshLinksMap.set(f.id, f.thumbnailLink.replace(/=s\d+.*$/, '=s1600'));
                }
            });
        }

        // Función auxiliar para inyectar links en una lista
        const refreshImages = (list) => {
            if (!list) return [];
            return list.map(item => {
                if (item.fileId && freshLinksMap.has(item.fileId)) {
                    item.imageUrl = freshLinksMap.get(item.fileId);
                }
                if (item.logoUrl && item.fileId && freshLinksMap.has(item.fileId)) {
                     item.logoUrl = freshLinksMap.get(item.fileId);
                }
                return item;
            });
        };

        // Aplicamos la frescura a todas las listas relevantes
        sheetsData.ProjectImages = refreshImages(sheetsData.ProjectImages);
        sheetsData.ServiceImages = refreshImages(sheetsData.ServiceImages);
        sheetsData.RentalItemImages = refreshImages(sheetsData.RentalItemImages);
        sheetsData.ClientLogos = refreshImages(sheetsData.ClientLogos);

        // Nota: Para 'Settings' y 'About' (imágenes únicas), la lógica es más compleja porque no son listas.
        // Si el logo principal falla, se podría agregar lógica específica aquí, pero por ahora cubrimos el 99% (galerías).

    } catch (e) {
        console.warn("Drive refresh failed, serving cached links:", e.message);
    }
    // ---------------------------------------------------

    // Procesamiento y Estructura de Datos (Igual que antes, pero con datos frescos)
    const portfolioImages = (sheetsData.ProjectImages || [])
      .filter(img => img.showInPortfolio && img.showInPortfolio.toLowerCase() === 'si')
      .sort((a, b) => (parseInt(a.portfolioOrder) || 99) - (parseInt(b.portfolioOrder) || 99));

    const settings = (sheetsData.Settings || []).reduce((acc, s) => { if (s.key) acc[s.key] = s.value; return acc; }, {});
    const aboutContent = (sheetsData.About || []).reduce((acc, i) => { if (i.section) acc[i.section] = i.content; return acc; }, {});

    const servicesWithContent = (sheetsData.Services || []).map(service => ({
        ...service,
        contentBlocks: (sheetsData.ServiceContentBlocks || []).filter(b => b.serviceId === service.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
        images: (sheetsData.ServiceImages || []).filter(i => i.serviceId === service.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));

    const rentalItemsWithImages = (sheetsData.RentalItems || []).map(item => ({
        ...item,
        images: (sheetsData.RentalItemImages || []).filter(i => i.itemId === item.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));
    
    const projectsWithImages = (sheetsData.Projects || []).map(project => {
        const pImages = (sheetsData.ProjectImages || []).filter(i => i.projectId === project.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));
        const cover = pImages.find(i => i.isCover && i.isCover.toLowerCase() === 'si');
        return { ...project, coverImageUrl: project.coverImageUrl || cover?.imageUrl || pImages[0]?.imageUrl || '', images: pImages };
    }).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));

    const websiteData = {
      settings, about: aboutContent, portfolioGallery: portfolioImages,
      videos: (sheetsData.Videos || []).sort((a, b) => (parseInt(a.order)||0)-(parseInt(b.order)||0)),
      clientLogos: (sheetsData.ClientLogos || []).sort((a, b) => (parseInt(a.order)||0)-(parseInt(b.order)||0)),
      projects: projectsWithImages, services: servicesWithContent,
      rentalCategories: (sheetsData.RentalCategories || []).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
      rentalItems: rentalItemsWithImages,
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(websiteData),
    };

  } catch (error) {
    console.error('Error fetching website data:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch website data', details: error.message }) };
  }
};
