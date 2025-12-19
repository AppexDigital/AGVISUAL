// functions/get-website-data.js
// v15.0 - INCLUSIÓN DE BLOQUEOS PARA DISPONIBILIDAD REAL
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

exports.handler = async (event, context) => {
  const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();

    // 1. AGREGAMOS LAS HOJAS DE IDENTIDAD QUE FALTABAN
    const sheetTitles = [
        'Identidad', 'About', 'ImagenesIdentidad', 'Videos', 'LogosClientes', 'Projects', 'ProjectImages', 
        'Services', 'ServiceContentBlocks', 'ServiceImages', 
        'RentalCategories', 'RentalItems', 'RentalItemImages', 'BlockedDates',
    ];
    
    const sheetsData = {};
    const promises = sheetTitles.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (sheet) {
                await sheet.loadHeaderRow();
                const rows = await sheet.getRows();
                const hVals = sheet.headerValues;
                sheetsData[title] = rows.map(row => {
                    const obj = {};
                    hVals.forEach(h => obj[h] = row.get(h) || '');
                    return obj;
                });
            } else { sheetsData[title] = []; }
        } catch(e) { sheetsData[title] = []; }
    });

    await Promise.all(promises);

    // --- PROCESAMIENTO DE DATOS ---

    // A. Identidad y Textos Globales
    const identity = (sheetsData.Identidad||[]).reduce((acc, i) => { if(i.key) acc[i.key] = i.value; return acc; }, {});
    const sysImages = (sheetsData.ImagenesIdentidad||[]).reduce((acc, i) => { if(i.key) acc[i.key] = i.imageUrl; return acc; }, {});
    const aboutContent = (sheetsData.About||[]).reduce((acc, i) => { if(i.section) acc[i.section] = i.content; return acc; }, {});

    // B. Galerías y Listas
    const portfolioImages = (sheetsData.ProjectImages||[]).filter(i => String(i.showInPortfolio).toLowerCase() === 'si').sort((a,b)=>(parseInt(a.portfolioOrder)||99)-(parseInt(b.portfolioOrder)||99));
    
    const servicesWithContent = (sheetsData.Services||[]).map(service => ({
        ...service,
        contentBlocks: (sheetsData.ServiceContentBlocks||[]).filter(b => b.serviceId === service.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
        images: (sheetsData.ServiceImages||[]).filter(i => i.serviceId === service.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));

    const rentalItemsWithImages = (sheetsData.RentalItems||[]).map(item => ({
        ...item,
        images: (sheetsData.RentalItemImages||[]).filter(i => i.itemId === item.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
    
    const projectsWithImages = (sheetsData.Projects||[]).map(project => {
        const pImages = (sheetsData.ProjectImages||[]).filter(i => i.projectId === project.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
        const cover = pImages.find(i => String(i.isCover).toLowerCase() === 'si');
        return { ...project, coverImageUrl: project.coverImageUrl || cover?.imageUrl || pImages[0]?.imageUrl || '', images: pImages };
    }).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));

    // C. Empaquetado Final
    const websiteData = {
      identity,      // Datos de contacto, redes, legal
      sysImages,     // Logos y foto de perfil
      about: aboutContent, 
      portfolioGallery: portfolioImages,
      videos: (sheetsData.Videos||[]).sort((a,b)=>(parseInt(a.order)||0)-(parseInt(b.order)||0)),
      clientLogos: (sheetsData.LogosClientes||[]).sort((a,b)=>(parseInt(a.order)||0)-(parseInt(b.order)||0)),
      projects: projectsWithImages, 
      services: servicesWithContent,
      rentalCategories: (sheetsData.RentalCategories||[]).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
      rentalItems: rentalItemsWithImages,
      blockedDates: sheetsData.BlockedDates || [] 
    };

    return { statusCode: 200, headers, body: JSON.stringify(websiteData) };

  } catch (error) { return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) }; }
};
