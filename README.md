# Central de Alarme JFL - Integração Node-RED

## Visão Geral

Esta solução completa permite controlar e monitorar uma central de alarme JFL através do Node-RED, oferecendo:

- **Controle remoto** via HTTP API, WebSocket e MQTT
- **Interface web** responsiva com teclado virtual
- **Dashboard React** avançado para monitoramento
- **Alertas em tempo real** com diferentes níveis de prioridade
- **Log de eventos** e auditoria de comandos
- **Notificações** por email e outros canais

## Componentes da Solução

### 1. Nó Node-RED Customizado (`alarme-jfl`)

**Funcionalidades:**
- Servidor TCP para comunicação com central JFL
- Processamento automático de diferentes tipos de pacotes
- Identificação automática do modelo da central
- Comandos: ARM_AWAY, ARM_STAY, DISARM, GET_STATE
- Keep-alive automático
- Log detalhado de eventos

**Configuração:**
- **Porta:** 9999 (padrão)
- **Host:** 0.0.0.0 (todas as interfaces)
- **Keep Alive:** Habilitado (30s)

### 2. Interface Web HTML

**Características:**
- Design moderno com CSS Grid e Flexbox
- Teclado virtual para entrada de códigos
- Status visual em tempo real
- Alertas com categorização por cores
- Responsivo para mobile e desktop

### 3. Dashboard React

**Funcionalidades Avançadas:**
- Estado em tempo real do sistema
- Painel de controle interativo
- Histórico de alertas
- Informações detalhadas do sistema
- Botões de emergência
- Indicadores visuais de status

## Instalação

### Pré-requisitos

```bash
# Node.js (versão 14+)
# Node-RED instalado
# Central JFL compatível (Active series, M-300)
```

### 1. Instalar o Nó Customizado

```bash
# Navegar para o diretório do Node-RED
cd ~/.node-red

# Criar diretório para nós customizados
mkdir -p nodes/alarme-jfl

# Copiar arquivos
cp alarme-jfl.js nodes/alarme-jfl/
cp alarme-jfl.html nodes/alarme-jfl/
cp package.json nodes/alarme-jfl/

# Reiniciar Node-RED
sudo systemctl restart nodered
```

### 2. Importar Fluxo

1. Abrir Node-RED (http://localhost:1880)
2. Menu → Import → Clipboard
3. Colar o JSON do fluxo completo
4. Deploy

### 3. Configurar Dependências

**MQTT Broker (opcional):**
```bash
# Mosquitto
sudo apt install mosquitto mosquitto-clients
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
```

**Email (opcional):**
- Configurar nó de email com credenciais SMTP
- Gmail: usar senha de app específica

### 4. Configurar Central JFL

**Configurações de Rede na Central:**
- IP do servidor Node-RED
- Porta: 9999
- Protocolo: TCP
- Envio periódico: Habilitado

**Modelos Testados:**
- Active-32 Duo (0xA0)
- Active 20 Ultra/GPRS (0xA1)
- Active 8 Ultra (0xA2)
- Active 20 Ethernet (0xA3)
- M-300+ (0x4B)

## Uso

### APIs Disponíveis

#### 1. Controle via HTTP

```bash
# Armar Total
curl -X POST http://localhost:1880/jfl/control \
  -H "Content-Type: application/json" \
  -d '{"command": "ARM_AWAY"}'

# Armar Parcial
curl -X POST http://localhost:1880/jfl/control \
  -H "Content-Type: application/json" \
  -d '{"command": "ARM_STAY"}'

# Desarmar (requer código)
curl -X POST http://localhost:1880/jfl/control \
  -H "Content-Type: application/json" \
  -d '{"command": "DISARM", "code": "1234"}'

# Obter Status
curl http://localhost:1880/jfl/status
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

# Assinar eventos
mosquitto_sub -h localhost -t "jfl/events"
mosquitto_sub -h localhost -t "jfl/status"
mosquitto_sub -h localhost -t "jfl/commands"
```

### Códigos de Eventos

| Código | Descrição | Tipo |
|--------|-----------|------|
| 3441 | Armado Parcial | Status |
| 3401-3409 | Armado Total | Status |
| 1401-1409 | Desarmado | Status |
| 1100-1109 | Alarme Zona | Alarme |
| 1130, 1134, 1137 | Alarme Incêndio | Crítico |
| 3130, 3134, 3137 | Incêndio Restaurado | Status |
| 1384 | Bateria Baixa | Manutenção |
| 1602 | Teste Periódico | Info |

### Estados do Sistema

- **DISARMED:** Sistema desarmado
- **ARMED_HOME:** Armado parcial (proteção perimetral)
- **ARMED_AWAY:** Armado total (proteção completa)
- **ALARM_SOUNDING:** Alarme ativado
- **FIRE_ALARM:** Alarme de incêndio

## Personalização

### Códigos de Usuário

Editar função `validateUserCode()`:

```javascript
function validateUserCode(code) {
    const validCodes = ['1234', '0000', '9999', 'seu_codigo'];
    return validCodes.includes(code);
}
```

### Adicionar Modelos JFL

Editar função `identifyModel()`:

```javascript
case 'XX': // Novo código hex
    modelo = 'Novo Modelo JFL';
    temEletrificador = true; // ou false
    break;
```

### Notificações Customizadas

Adicionar novos canais no fluxo:
- SMS via API
- Push notifications
- Telegram bot
- Webhook personalizado

## Monitoramento

### Logs

```bash
# Logs do Node-RED
journalctl -u nodered -f

# Arquivo de eventos (se configurado)
tail -f /data/jfl_events.log
```

### Debug

1. Habilitar debug no nó "Debug JFL"
2. Monitorar aba Debug no Node-RED
3. Verificar status dos nós no fluxo

### Métricas

O sistema armazena automaticamente:
- Histórico de eventos (últimos 1000)
- Histórico de comandos (últimos 100)
- Informações de clientes conectados
- Status atual do sistema

## Solução de Problemas

### Central não Conecta

1. Verificar IP e porta na central
2. Verificar firewall
3. Testar conexão: `telnet IP_NODERED 9999`
4. Verificar logs do Node-RED

### Comandos não Funcionam

1. Verificar se central está conectada
2. Validar códigos de usuário
3. Verificar modelo da central suportado
4. Revisar logs de debug

### Interface não Atualiza

1. Verificar conexão WebSocket
2. Limpar cache do navegador
3. Verificar JavaScript console
4. Validar configuração do WebSocket

## Segurança

### Recomendações

1. **Códigos fortes:** Use códigos de 6+ dígitos
2. **HTTPS:** Configure certificado SSL
3. **Firewall:** Limite acesso às portas
4. **VPN:** Use VPN para acesso remoto
5. **Logs:** Monitore acessos não autorizados

### Autenticação

Para produção, implemente:
- Autenticação JWT
- Rate limiting
- Controle de acesso baseado em funções
- Criptografia de códigos

## Contribuição

Para contribuir com melhorias:

1. Fork do repositório
2. Criar branch para feature
3. Implementar melhorias
4. Testes em diferentes modelos JFL
5. Pull request com documentação

## Suporte

Para dúvidas e suporte:
- Documentação Node-RED: https://nodered.org/docs/
- Manual central JFL
- Fórum Node-RED: https://discourse.nodered.org/

## Licença

MIT License - Livre para uso pessoal e comercial.
