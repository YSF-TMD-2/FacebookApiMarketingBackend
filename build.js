import fs from 'fs';
import path from 'path';

// Liste des fichiers à traiter
const files = [
  'src/routes/authRoutes.ts',
  'src/routes/facebookRoutes.ts', 
  'src/controllers/authController.ts',
  'src/controllers/facebookController.ts',
  'src/middleware/authMiddleware.ts',
  'src/services/loggerService.ts',
  'src/server.ts'
];

console.log('🔧 Préparation du build pour Vercel...');

files.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`📝 Traitement de ${file}`);
    let content = fs.readFileSync(file, 'utf8');
    
    // Remplacer les imports .ts par .js
    content = content.replace(/from ['"]([^'"]+)\.ts['"]/g, 'from "$1.js"');
    content = content.replace(/import ['"]([^'"]+)\.ts['"]/g, 'import "$1.js"');
    
    fs.writeFileSync(file, content);
    console.log(`✅ ${file} traité`);
  } else {
    console.log(`⚠️  Fichier non trouvé: ${file}`);
  }
});

console.log('🎉 Préparation terminée !');
