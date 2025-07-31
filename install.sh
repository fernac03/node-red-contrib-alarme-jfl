#!/bin/bash

# Script de Instalação Automática - Central JFL Node-RED
# Versão: 2.0.0
# Autor: Sistema JFL Integration

set -e  # Parar em caso de erro

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Funções de log
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verificar se está rodando como root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_error "Este script não deve ser executado como root!"
        log_info "Execute como usuário normal: ./install.sh"
        exit 1
    fi
}

# Verificar dependências
check_dependencies() {
    log_info "Verificando dependências..."
    
    # Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js não encontrado!"
        log_info "Instale Node.js (versão 14+): https://nodejs.org/"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 14 ]; then
        log_error "Node.js versão $NODE_VERSION encontrada. Versão 14+ necessária."
        exit 1
    fi
    
    log_success "Node.js $(node -v) ✓"
    
    # NPM
    if ! command -v npm &> /dev/null; then
        log_error "NPM não encontrado!"
        exit 1
    fi
    
    log_success "NPM $(npm -v) ✓"
    
    # Node-RED
    if ! command -v node-red &> /dev/null; then
        log_warning "Node-RED não encontrado. Será instalado..."
        INSTALL_NODERED=true
    else
        log_success "Node-RED encontrado ✓"
        INSTALL_NODERED=false
    fi
}

# Instalar Node-RED se necessário
install_nodered() {
    if [ "$INSTALL_NODERED" = true ]; then
        log_info "Instalando Node-RED..."
        sudo npm install -g --unsafe-perm node-red
        log_success "Node-RED instalado!"
        
        # Criar diretório de dados
        mkdir -p ~/.node-red
        
        # Inicializar Node-RED (primeira execução)
        log_info "Inicializando Node-RED..."
        timeout 10s node-red > /dev/null 2>&1 || true
        sleep 2
        pkill -f node-red || true
    fi
}

# Instalar MQTT (opcional)
install_mqtt() {
    read -p "Deseja instalar Mosquitto MQTT broker? [y/N]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Instalando Mosquitto MQTT..."
        
        if command -v apt-get &> /dev/null; then
            sudo apt-get update
            sudo apt-get install -y mosquitto mosquitto-clients
            sudo systemctl enable mosquitto
            sudo systemctl start mosquitto
        elif command -v yum &> /dev/null; then
            sudo yum install -y mosquitto mosquitto-clients
            sudo systemctl enable mosquitto
            sudo systemctl start mosquitto
        elif command -v brew &> /dev/null; then
            brew install mosquitto
            brew services start mosquitto
        else
            log_warning "Sistema operacional não suportado para instalação automática do MQTT"
            log_info "Instale manualmente: https://mosquitto.org/download/"
        fi
        
        log_success "Mosquitto MQTT instalado!"
    fi
}

# Criar diretórios necessários
create_directories() {
    log_info "Criando estrutura de diretórios..."
    
    mkdir -p ~/.node-red/nodes/alarme-jfl
    mkdir -p ~/.node-red/data/jfl
    mkdir -p ~/.node-red/projects/jfl-system
    
    log_success "Diretórios criados!"
}

# Instalar nó customizado
install_custom_node() {
    log_info "Instalando nó customizado JFL..."
    
    NODE_DIR="$HOME/.node-red/nodes/alarme-jfl"
    
    # Criar arquivos do nó
    cat > "$NODE_DIR/package.json" << 'EOF'
{
    "name": "node-red-contrib-alarme-jfl",
    "version": "2.0.0",
    "description": "Nó Node-RED para comunicação completa com central de alarme JFL via TCP socket",
    "main": "alarme-jfl.js",
    "keywords": [
        "node-red",
        "alarme",
        "jfl",
        "tcp",
        "socket",
        "security"
    ],
    "author": "JFL Integration",
    "license": "MIT",
    "node-red": {
        "version": ">=2.0.0",
        "nodes": {
            "alarme-jfl": "alarme-jfl.js"
        }
    }
}
EOF
    
    log_info "Arquivos do nó customizado criados..."
    log_info "ATENÇÃO: Você deve copiar manualmente os arquivos:"
    log_info "  - alarme-jfl.js -> $NODE_DIR/"
    log_info "  - alarme-jfl.html -> $NODE_DIR/"
    
    log_success "Estrutura do nó customizado preparada!"
}

# Configurar Node-RED
configure_nodered() {
    log_info "Configurando Node-RED..."
    
    SETTINGS_FILE="$HOME/.node-red/settings.js"
    
    # Backup do arquivo original
    if [ -f "$SETTINGS_FILE" ]; then
        cp "$SETTINGS_FILE" "$SETTINGS_FILE.backup.$(date +%Y%m%d-%H%M%S)"
    fi
    
    # Configurações básicas
    cat > "$SETTINGS_FILE" << 'EOF'
module.exports = {
    uiPort: process.env.PORT || 1880,
    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,
    httpNodeCors: {
        origin: "*",
        methods: "GET,PUT,POST,DELETE"
    },
    functionGlobalContext: {
        // Contexto global para funções
    },
    exportGlobalContextKeys: false,
    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: false
        },
        file: {
            level: "info",
            filename: process.env.HOME + "/.node-red/node-red.log",
            maxFiles: 5,
            maxSize: "1MB"
        }
    },
    editorTheme: {
        projects: {
            enabled: true
        }
    }
}
EOF
    
    log_success "Node-RED configurado!"
}

# Instalar dependências adicionais
install_additional_deps() {
    log_info "Instalando dependências adicionais do Node-RED..."
    
    cd ~/.node-red
    
    # Nós essenciais
    npm install node-red-dashboard
    npm install node-red-contrib-telegrambot
    npm install node-red-node-email
    npm install node-red-contrib-mqtt-broker
    
    log_success "Dependências instaladas!"
}

# Criar scripts de controle
create_control_scripts() {
    log_info "Criando scripts de controle..."
    
    # Script de início
    cat > ~/start-jfl-system.sh << 'EOF'
#!/bin/bash
echo "Iniciando Sistema JFL Node-RED..."
cd ~/.node-red
node-red
EOF
    
    # Script de parada
    cat > ~/stop-jfl-system.sh << 'EOF'
#!/bin/bash
echo "Parando Sistema JFL Node-RED..."
pkill -f node-red
echo "Sistema parado."
EOF
    
    # Script de status
    cat > ~/status-jfl-system.sh << 'EOF'
#!/bin/bash
if pgrep -f node-red > /dev/null; then
    echo "✅ Sistema JFL Node-RED está RODANDO"
    echo "URL: http://localhost:1880"
    echo "WebSocket: ws://localhost:1880/ws/jfl"
    echo "API: http://localhost:1880/jfl/"
else
    echo "❌ Sistema JFL Node-RED está PARADO"
fi
EOF
    
    chmod +x ~/start-jfl-system.sh
    chmod +x ~/stop-jfl-system.sh
    chmod +x ~/status-jfl-system.sh
    
    log_success "Scripts de controle criados!"
}

# Criar serviço systemd (opcional)
create_systemd_service() {
    read -p "Deseja criar serviço systemd para inicialização automática? [y/N]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Criando serviço systemd..."
        
        sudo tee /etc/systemd/system/jfl-nodered.service > /dev/null << EOF
[Unit]
Description=JFL Node-RED Sistema de Alarme
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/.node-red
ExecStart=$(which node-red)
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=jfl-nodered
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
        
        sudo systemctl daemon-reload
        sudo systemctl enable jfl-nodered
        
        log_success "Serviço systemd criado!"
        log_info "Use: sudo systemctl start jfl-nodered"
        log_info "Use: sudo systemctl status jfl-nodered"
    fi
}

# Criar arquivos de exemplo
create_examples() {
    log_info "Criando arquivos de exemplo..."
    
    EXAMPLES_DIR="$HOME/.node-red/projects/jfl-system"
    
    # Exemplo de configuração
    cat > "$EXAMPLES_DIR/config-example.json" << 'EOF'
{
    "jfl": {
        "port": 9999,
        "host": "0.0.0.0",
        "keepAlive": true,
        "keepAliveInterval": 30000,
        "validCodes": ["1234", "0000", "9999"]
    },
    "notifications": {
        "email": {
            "enabled": false,
            "smtp": "smtp.gmail.com",
            "port": 465,
            "user": "seu-email@gmail.com",
            "password": "sua-senha-app"
        },
        "telegram": {
            "enabled": false,
            "botToken": "SEU_BOT_TOKEN",
            "chatId": "SEU_CHAT_ID"
        }
    },
    "mqtt": {
        "enabled": true,
        "broker": "localhost",
        "port": 1883,
        "topics": {
            "events": "jfl/events",
            "status": "jfl/status",
            "commands": "jfl/commands"
        }
    }
}
EOF
    
    # Exemplo de teste
    cat > "$EXAMPLES_DIR/test-api.sh" << 'EOF'
#!/bin/bash
# Script de teste da API JFL

BASE_URL="http://localhost:1880/jfl"

echo "🔍 Testando API JFL..."

# Teste de status
echo "📊 Status do sistema:"
curl -s "$BASE_URL/status" | jq '.' || echo "Erro: jq não instalado"

echo -e "\n🎮 Enviando comando ARM_AWAY:"
curl -s -X POST "$BASE_URL/control" \
    -H "Content-Type: application/json" \
    -d '{"command": "ARM_AWAY"}' | jq '.' || echo "Comando enviado"

echo -e "\n🏠 Enviando comando ARM_STAY:"
curl -s -X POST "$BASE_URL/control" \
    -H "Content-Type: application/json" \
    -d '{"command": "ARM_STAY"}' | jq '.' || echo "Comando enviado"

echo -e "\n🔓 Enviando comando DISARM (com código):"
curl -s -X POST "$BASE_URL/control" \
    -H "Content-Type: application/json" \
    -d '{"command": "DISARM", "code": "1234"}' | jq '.' || echo "Comando enviado"

echo -e "\n✅ Testes concluídos!"
EOF
    
    chmod +x "$EXAMPLES_DIR/test-api.sh"
    
    log_success "Arquivos de exemplo criados em $EXAMPLES_DIR"
}

# Função principal
main() {
    echo "======================================"
    echo "  Central JFL Node-RED - Instalador  "
    echo "           Versão 2.0.0              "
    echo "======================================"
    echo
    
    check_root
    check_dependencies
    install_nodered
    install_mqtt
    create_directories
    install_custom_node
    configure_nodered
    install_additional_deps
    create_control_scripts
    create_systemd_service
    create_examples
    
    echo
    echo "======================================"
    log_success "INSTALAÇÃO CONCLUÍDA!"
    echo "======================================"
    echo
    log_info "Próximos passos:"
    echo "1. Copie os arquivos do nó customizado:"
    echo "   - alarme-jfl.js -> ~/.node-red/nodes/alarme-jfl/"
    echo "   - alarme-jfl.html -> ~/.node-red/nodes/alarme-jfl/"
    echo
    echo "2. Inicie o Node-RED:"
    echo "   ./start-jfl-system.sh"
    echo
    echo "3. Acesse: http://localhost:1880"
    echo
    echo "4. Importe o fluxo JFL completo"
    echo
    echo "5. Configure sua central JFL para conectar na porta 9999"
    echo
    log_info "Scripts disponíveis:"
    echo "   ~/start-jfl-system.sh   - Iniciar sistema"
    echo "   ~/stop-jfl-system.sh    - Parar sistema"
    echo "   ~/status-jfl-system.sh  - Status do sistema"
    echo
    log_info "Testes:"
    echo "   ~/.node-red/projects/jfl-system/test-api.sh"
    echo
    log_warning "Lembre-se de configurar códigos de usuário seguros!"
    echo
}

# Executar instalação
main "$@"
