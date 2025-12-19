// functions/get-website-data.js
// v16.0 - INCLUSIÓN DE BLOQUEOS PARA DISPONIBILIDAD REAL y descarga fraccionada
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

    // 1. DEFINIR PAQUETES DE CARGA
    // El parámetro 'section' decide qué hojas descargar
    const section = event.queryStringParameters?.section || 'home';
    let sheetsToLoad = [];

    if (section === 'home') {
        // Carga inicial ligera: Identidad, Portafolio (Fotos), Videos y Logos
        sheetsToLoad = ['Identidad', 'ImagenesIdentidad', 'About', 'Videos', 'LogosClientes', 'ProjectImages'];
    } else if (section === 'projects') {
        // Solo la lista de proyectos (Las fotos ya se cargaron en home con ProjectImages)
        sheetsToLoad = ['Projects'];
    } else if (section === 'services') {
        // Datos exclusivos de servicios
        sheetsToLoad = ['Services', 'ServiceContentBlocks', 'ServiceImages'];
    } else if (section === 'rentals') {
        // Datos exclusivos de alquiler
        sheetsToLoad = ['RentalCategories', 'RentalItems', 'RentalItemImages', 'BlockedDates'];
    }

    const sheetsData = {};
    // Solo cargamos las hojas necesarias para esta sección
    const promises = sheetsToLoad.map(async (title) => {
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

    // 2. PROCESAMIENTO SEGÚN SECCIÓN
    const responseData = {};

    if (section === 'home') {
        responseData.identity = (sheetsData.Identidad||[]).reduce((acc, i) => { if(i.key) acc[i.key] = i.value; return acc; }, {});
        responseData.sysImages = (sheetsData.ImagenesIdentidad||[]).reduce((acc, i) => { if(i.key) acc[i.key] = i.imageUrl; return acc; }, {});
        responseData.about = (sheetsData.About||[]).reduce((acc, i) => { if(i.section) acc[i.section] = i.content; return acc; }, {});
        
        responseData.videos = (sheetsData.Videos||[]).sort((a,b)=>(parseInt(a.order)||0)-(parseInt(b.order)||0));
        responseData.clientLogos = (sheetsData.LogosClientes||[]).sort((a,b)=>(parseInt(a.order)||0)-(parseInt(b.order)||0));
        
        // Filtramos fotos para el portafolio (ShowInPortfolio = Si)
        responseData.portfolioGallery = (sheetsData.ProjectImages||[]).filter(i => String(i.showInPortfolio).toLowerCase() === 'si').sort((a,b)=>(parseInt(a.portfolioOrder)||99)-(parseInt(b.portfolioOrder)||99));
        
        // Enviamos TODAS las imágenes de proyectos aquí para tenerlas en caché (son ligeras comparadas con volver a llamar a la API)
        responseData.allProjectImages = sheetsData.ProjectImages || [];
    }

    if (section === 'projects') {
        responseData.projects = (sheetsData.Projects||[]).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
    }

    if (section === 'services') {
        responseData.services = (sheetsData.Services||[]).map(service => ({
            ...service,
            contentBlocks: (sheetsData.ServiceContentBlocks||[]).filter(b => b.serviceId === service.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
            images: (sheetsData.ServiceImages||[]).filter(i => i.serviceId === service.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
        })).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
    }

    if (section === 'rentals') {
        responseData.rentalCategories = (sheetsData.RentalCategories||[]).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
        responseData.blockedDates = sheetsData.BlockedDates || [];
        responseData.rentalItems = (sheetsData.RentalItems||[]).map(item => ({
            ...item,
            images: (sheetsData.RentalItemImages||[]).filter(i => i.itemId === item.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
        })).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
    }

    return { statusCode: 200, headers, body: JSON.stringify(responseData) };

  } catch (error) { return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) }; }
};
