# 🛡️ Central de Alarme JFL - Integração Node-RED

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/usuario/node-red-contrib-alarme-jfl)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D2.0.0-red.svg)](https://nodered.org/)

Sistema completo de monitoramento e controle para centrais de alarme JFL através do Node-RED, oferecendo interface web moderna, APIs REST/WebSocket/MQTT e notificações em tempo real.

## 🚀 Características Principais

- ✅ **Comunicação TCP completa** com central JFL
- 🎛️ **Interface web responsiva** com teclado virtual
- 📱 **Dashboard React avançado** para monitoramento
- 🔗 **APIs múltiplas**: HTTP REST, WebSocket, MQTT
- 📧 **Notificações**: Email, Telegram, SMS
- 📊 **Monitoramento em tempo real** de eventos
- 🔒 **Sistema de segurança** com validação de códigos
- 📝 **Log completo** e auditoria de comandos
- 🏥 **Monitoramento de saúde** do sistema

## 🏭 Modelos JFL Suportados

| Modelo | Código | Eletrificador | Status |
|--------|--------|---------------|--------|
| Active-32 Duo | 0xA0 | ✅ | ✅ Testado |
| Active 20 Ultra/GPRS | 0xA1 | ✅ | ✅ Testado |
| Active 8 Ultra | 0xA2 | ❌ | ✅ Testado |
| Active 20 Ethernet | 0xA3 | ✅ | ✅ Testado |
| Active 100 Bus | 0xA4 | ✅ | 🧪 Experimental |
| Active 20 Bus | 0xA5 | ✅ | 🧪 Experimental |
| Active Full 32 | 0xA6 | ❌ | 🧪 Experimental |
| Active 20 | 0xA7 | ✅ | ✅ Testado |
| Active 8W | 0xA8 | ✅ | 🧪 Experimental |
| M-300+ | 0x4B | ❌ | ✅ Testado |
| M-300 Flex | 0x5D | ❌ | 🧪 Experimental |

## 📦 Instalação

### Instalação Automática (Recomendada)

```bash
# Download do instalador
curl -O https://raw.githubusercontent.com/usuario/node-red-contrib-alarme-jfl/main/install.sh
chmod +x install.sh

# Executar instalação
./install.sh
```

### Instalação Manual

#### 1. Pré-requisitos

```bash
# Node.js 14+ e NPM
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Node-RED
sudo npm install -g --unsafe-perm node-red

# MQTT (opcional)
sudo apt-get install mosquitto mosquitto-clients
```

#### 2. Instalar Nó Customizado

```bash
# Criar diretório
mkdir -p ~/.node-red/nodes/alarme-jfl

# Copiar arquivos (baixar do repositório)
cp alarme-jfl.js ~/.node-red/nodes/alarme-jfl/
cp alarme-jfl.html ~/.node-red/nodes/alarme-jfl/
cp package.json ~/.node-red/nodes/alarme-jfl/

# Instalar dependências do Node-RED
cd ~/.node-red
npm install node-red-dashboard node-red-contrib-telegrambot node-red-node-email
```

#### 3. Configurar e Iniciar

```bash
# Iniciar Node-RED
node-red

# Acessar interface: http://localhost:1880
# Importar fluxo JFL completo
# Configurar central JFL para conectar na porta 9999
```

## 🔧 Configuração

### Central JFL

Configure sua central JFL com as seguintes opções de rede:

```
IP Servidor: [IP_DO_SERVIDOR_NODE_RED]
Porta: 9999
Protocolo: TCP
Envio Periódico: Habilitado
Intervalo: 30 segundos
```

### Códigos de Usuário

⚠️ **IMPORTANTE**: Altere os códigos padrão antes do uso em produção!

Edite no arquivo `alarme-jfl.js`:

```javascript
function validateUserCode(code) {
    const validCodes = ['1234', '0000', '9999']; // ALTERAR ESTES CÓDIGOS!
    return validCodes.includes(code);
}
```

### Notificações

#### Email (Gmail)

```javascript
// No nó de email, configurar:
{
    "server": "smtp.gmail.com",
    "port": 465,
    "secure": true,
    "user": "seu-email@gmail.com",
    "pass": "sua-senha-de-app-específica"
}
```

#### Telegram

1. Criar bot: conversar com @BotFather
2. Obter token do bot
3. Obter ID do chat/grupo
4. Configurar no nó Telegram

## 🎮 Uso

### APIs Disponíveis

#### 1. HTTP REST API

```bash
# Status do sistema
curl http://localhost:1880/jfl/status

# Armar total
curl -X POST http://localhost:1880/jfl/control \
  -H "Content-Type: application/json" \
  -d '{"command": "ARM_AWAY"}'

# Armar parcial
curl -X POST http://localhost:1880/jfl/control \
  -H "Content-Type: application/json" \
  -d '{"command": "ARM_STAY"}'

# Desarmar (com código)
curl -X POST http://localhost:1880/jfl/control \
  -H "Content-Type: application/json" \
  -d '{"command": "DISARM", "code": "1234"}'
```

#### 2. WebSocket

```javascript
const ws = new WebSocket('ws://localhost:1880/ws/jfl');

// Enviar comando
ws.send(JSON.stringify({
    command: 'ARM_AWAY'
}));

// Receber eventos
ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('Evento JFL:', data);
};
```

#### 3. MQTT

```bash
# Publicar comando
mosquitto_pub -h localhost -t "jfl/commands/input" \
  -m '{"command": "ARM_AWAY"}'

# Escutar eventos
mosquitto_sub -h localhost -t "jfl/events"
mosquitto_sub -h localhost -t "jfl/status"
```

### Comandos Suportados

| Comando | Descrição | Código Necessário |
|---------|-----------|-------------------|
| `ARM_AWAY` | Armamento total | ❌ |
| `ARM_STAY` | Armamento parcial | ❌ |
| `DISARM` | Desarmamento | ✅ |
| `GET_STATE` | Status atual | ❌ |
| `CLEAR_ALERTS` | Limpar alertas | ❌ |

### Códigos de Eventos

| Código | Descrição | Prioridade |
|--------|-----------|------------|
| `3441` | Sistema armado parcialmente | Alta |
| `3401-3409` | Sistema armado totalmente | Alta |
| `1401-1409` | Sistema desarmado | Alta |
| `1100-1109` | Alarme de zona | **Crítica** |
| `1130, 1134, 1137` | Alarme de incêndio | **Crítica** |
| `3130, 3134, 3137` | Incêndio restaurado | Normal |
| `1384` | Bateria baixa | Normal |
| `1602` | Teste periódico | Normal |

## 🖥️ Interfaces Web

### Interface HTML Básica

- Teclado virtual para códigos
- Status visual em tempo real
- Histórico de alertas
- Design responsivo

### Dashboard React Avançado

- Painel de controle completo
- Monitoramento de saúde do sistema
- Informações detalhadas da central
- Alertas categorizados
- Botões de emergência

## 📊 Monitoramento

### Logs

```bash
# Logs do Node-RED
tail -f ~/.node-red/node-red.log

# Eventos JFL (se configurado)
tail -f ~/.node-red/data/jfl/jfl_events_$(date +%Y-%m-%d).log

# Status do sistema
./status-jfl-system.sh
```

### Métricas Armazenadas

- ✅ Histórico de eventos (últimos 1000)
- ✅ Histórico de comandos (últimos 100)
- ✅ Informações de clientes conectados
- ✅ Estatísticas do sistema
- ✅ Status de saúde em tempo real

## 🔒 Segurança

### Recomendações

1. **Códigos Fortes**: Use códigos de 6+ dígitos únicos
2. **HTTPS**: Configure certificado SSL em produção
3. **Firewall**: Limite acesso às portas (1880, 9999)
4. **VPN**: Use VPN para acesso remoto
5. **Monitoramento**: Monitore logs de acesso
6. **Backup**: Faça backup regular das configurações

### Implementações de Segurança

- ✅ Validação de códigos de usuário
- ✅ Log de auditoria completo
- ✅ Timeout de sessão
- ✅ Validação de entrada
- ✅ Mascaramento de códigos nos logs

## 🛠️ Desenvolvimento

### Estrutura do Projeto

```
~/.node-red/
├── nodes/alarme-jfl/
│   ├── alarme-jfl.js          # Lógica principal do nó
│   ├── alarme-jfl.html        # Interface do nó
│   └── package.json           # Configurações do nó
├── data/jfl/                  # Dados e logs
├── projects/jfl-system/       # Exemplos e utilitários
└── flows.json                 # Fluxos Node-RED
```

### Contribuindo

1. Fork do repositório
2. Criar branch: `git checkout -b feature/nova-funcionalidade`
3. Commit: `git commit -am 'Adicionar nova funcionalidade'`
4. Push: `git push origin feature/nova-funcionalidade`
5. Pull Request

### Testes

```bash
# Testar API
~/.node-red/projects/jfl-system/test-api.sh

# Testar WebSocket
node test-websocket.js

# Testar MQTT
mosquitto_pub -h localhost -t "jfl/commands/input" -m '{"command":"GET_STATE"}'
```

## 🐛 Solução de Problemas

### Central não Conecta

1. ✅ Verificar IP e porta na central JFL
2. ✅ Verificar firewall (porta 9999)
3. ✅ Testar conectividade: `telnet IP_SERVER 9999`
4. ✅ Verificar logs: `tail -f ~/.node-red/node-red.log`

### Comandos não Funcionam

1. ✅ Verificar se central está conectada
2. ✅ Validar códigos de usuário
3. ✅ Verificar modelo suport
