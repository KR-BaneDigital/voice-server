const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting agent language migration...');
  
  try {
    const migrationPath = path.join(__dirname, '..', 'prisma', 'migrations', '20260202_add_agent_language.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');
    
    // Split SQL into individual statements
    const statements = migrationSQL
      .split('\n')
      .filter(line => !line.trim().startsWith('--') && !line.trim().startsWith('COMMENT'))
      .join('\n')
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('COMMENT'));
    
    console.log(`⚙️  Executing ${statements.length} SQL statements...`);
    
    // Execute each statement individually
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement) {
        console.log(`   [${i + 1}/${statements.length}] Executing...`);
        await prisma.$executeRawUnsafe(statement + ';');
      }
    }
    
    console.log('✅ Migration completed successfully!');
    console.log('\n📝 Language field added to ai_agents table (default: en)');
    console.log('🔄 Next step: Run npx prisma generate');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
