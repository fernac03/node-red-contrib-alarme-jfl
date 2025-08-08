// alarme-jfl.js - VersÃ£o Final
module.exports = function(RED) {
    "use strict";
    
    function AlarmeJFLNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const net = require('net');
        let server = null;
        let pgms = null;
        let particoes = null;
        let numZonas = null;
        let sensors = {};
        let zonas = {};
        // ConfiguraÃ§Ãµes
        const port = parseInt(config.port) || 9999;
        const host = config.host || '0.0.0.0';
        const keepAliveInterval = parseInt(config.keepAliveInterval) || 30000;
        const getStateInterval = parseInt(config.getStateInterval) || 5;
        
        let keepAliveTimer = null;

        let getStateTimer = null;
        let connectedSockets = new Set();
        let clientStartBytes = new Map();
        
        // Estado atual do alarme
        let currentAlarmState = {
            armed_away: false,
            armed_night: false,
            armed_home: false,
            alarm_sounding: false,
            fire_alarm: false,
            eletrificador: false,
            state: 'DISARMED'
        };
        
        // CÃ³digos de comando para o alarme
        const alarmCommands = {
            armAway: [0x06, 0x01, 0x4E, 0x01],
            armStay: [0x06, 0x01, 0x53, 0x01],
            disarm: [0x06, 0x01, 0x4F, 0x01],
            
        };
        
        // FunÃ§Ã£o para calcular checksum XOR
        function calculateChecksum(buffer) {
            let checksum = 0;
            for (let i = 0; i < buffer.length; i++) {
                checksum ^= buffer[i];
            }
            return checksum;
        }
        
        // FunÃ§Ã£o para criar mensagem de resposta padrÃ£o
        function createResponseMessage(msg) {
            const baseMessage = Buffer.from(msg);
            const checksum = calculateChecksum(baseMessage);
            return Buffer.concat([baseMessage, Buffer.from([checksum])]);
        }
        
        // FunÃ§Ã£o para identificar modelo da central baseado no byte 41
        function identifyModel(data) {
            if (data.length < 42) {
                return { modelo: 'Desconhecido', temEletrificador: false };
            }
            
            const modelByte = data[41];
            const modelHex = modelByte.toString(16).toUpperCase().padStart(2, '0');
            
            let modelo = 'Desconhecido';
            let temEletrificador = false;
            
            switch (modelHex) {
                case 'A0':
                    modelo = 'Active-32 Duo';
                    temEletrificador = true;
                    pgms = 4;
                    particoes= 4;
                    numZonas = 32;
                    break;
                case 'A1':
                    modelo = 'Active 20 Ultra/GPRS';
                    temEletrificador = true;
                    pgms = 4;
                    particoes= 2;
                    numZonas = 22;
                    break;
                case 'A2':
                    modelo = 'Active 8 Ultra';
                    temEletrificador = false;
                    pgms = 0;
                    particoes= 2;
                    numZonas = 12;
                    break;
                case 'A3':
                    modelo = 'Active 20 Ethernet';
                    temEletrificador = true;
                    pgms = 4;
                    particoes= 2;
                    numZonas = 22;
                    break;
                case 'A4':
                    modelo = 'Active 100 Bus';
                    temEletrificador = true;
                    pgms = 16;
                    particoes= 16;
                    numZonas = 99;
                    break;
                case 'A5':
                    modelo = 'Active 20 Bus';
                    temEletrificador = true;
                    pgms = 16;
                    particoes= 2;
                    numZonas = 32;
                    break;
                case 'A6':
                    modelo = 'Active Full 32';
                    temEletrificador = false;
                    pgms = 16;
                    particoes= 4;
                    numZonas = 32;
                    break;
                case 'A7':
                    modelo = 'Active 20';
                    temEletrificador = true;
                    pgms = 4;
                    particoes= 2;
                    numZonas = 32;
                    break;
                case 'A8':
                    modelo = 'Active 8W';
                    temEletrificador = true;
                    pgms = 4;
                    particoes= 2;
                    numZonas = 32;
                    break;
                case '4B':
                    modelo = 'M-300+';
                    temEletrificador = false;
                    pgms = 4;
                    particoes= 0;
                    numZonas = 0;
                    break;
                case '5D':
                    modelo = 'M-300 Flex';
                    temEletrificador = false;
                    pgms = 2;
                    particoes= 0;
                    numZonas = 0;
                    break;
                default:
                    modelo = `Modelo nÃ£o identificado (0x${modelHex})`;
                    temEletrificador = false;
                    numZonas = 0;
            }
            
            return { modelo, temEletrificador,numZonas };
        }
        //FunÃ§Ã£o para atualizar as zonas;
        function setZoneStatus(zona, status) {
           const statusMap = {
              0: "disabled",
              1: "inhibited", 
              2: "triggered",
              3: "no_communication",
              4: "short_circuit",
              5: "tamper_open",
              6: "low_battery",
              7: "open",
              8: "closed"
           };
           const zonaId = `zona_${zona}`;
           const mappedStatus = statusMap[status] || "STATE_UNKNOWN";
           zonas[zonaId] = {
             "state": mappedStatus,
             "name": `Zona ${zona}`
           };
           if ([2, 4, 5, 7].includes(status)) {
             zonas[zonaId] = {
               "state": "ON",
               "name": `Zona ${zona}`
            };
          } else {
            zonas[zonaId] = {
              "state": "OFF", 
              "name": `Zona ${zona}`
            };
         }
    
       }
 
        //FunÃ§Ã£o para inicialiar as zona;
        function initializeZonas() {
            node.warn('inicializando as zonas da central#################################################################');
            for (let i = 0; i < numZonas; i++) {
                const zonaId = `zona_${i + 1}`;
                zonas[zonaId] = {
                name: `Zona ${i + 1}`,
                state: false
               };
          }
          // Salva as zonas no contexto global
          node.warn('zonas da central Inicializadas #################################################################');
        
        }
        // FunÃ§Ã£o para inicializar o eletrificador
        function initializeEletrificador() {
           node.warn('inicializando eletrificador da central#################################################################');
           let pgms = global.get('pgms') || {};
           pgms["eletrificador"] = {
               name: "Eletrificador",
               state: "OFF",
               type: "toggle",
               switch_number: 99,
               tipo: "ELETRIFICADOR"
           };
           // Salva os PGMs no contexto global
           global.set('pgms', pgms);
           return { payload: pgms.eletrificador, topic: 'eletrificador_initialized' };
         }
        // FunÃ§Ã£o para Inicializar os  sensores
        function initializeSensors() {
           node.warn('inicializando os sensores da central#################################################################');
           
           sensors['bateria'] = {
              name: "Bateria",
              state: null,
              device_class: "BATTERY"
            };
            // Salva os sensores no contexto global
            global.set('sensors', sensors);
            return { payload: sensors.bateria, topic: 'sensors_initialized' };
         }
        // FunÃ§Ã£o para inicializar as partiÃ§Ãµes
        function initializeParticoes() {
           const numParticoes = global.get('num_particoes') || 4; // valor padrÃ£o
           node.warn('inicializando as partiÃ§Ãµes da central#################################################################');
           let sensors = global.get('sensors') || {};  
           for (let i = 0; i < numParticoes; i++) {
              const particaoId = `particao_${i + 1}`;
              sensors[particaoId] = {
                 name: `Particao ${i + 1}`,
                 state: "DISARMED",
                 device_class: "ENUM"
             };
           }
           // Salva os sensores no contexto global
           global.set('sensors', sensors);
           return { payload: sensors, topic: 'particoes_initialized' };
        } 
        // funÃ§Ã£o para inicializar as pgms
        function initializePgms() {
           const numPgms = global.get('num_pgms') || 8; // valor padrÃ£o
           node.warn('inicializando as pgms da central#################################################################');
           let pgms = global.get('pgms') || {};
           for (let i = 0; i < numPgms; i++) {
               const pgmId = `pgm_${i + 1}`;
               pgms[pgmId] = {
                   name: `Pgm ${i + 1}`,
                   state: "OFF",
                   type: "toggle",
                   switch_number: i + 1, 
                   tipo: "PGM"
              };
          }
          // Salva os PGMs no contexto global
          global.set('pgms', pgms);
          return { payload: pgms, topic: 'pgms_initialized' };
        }
        // FunÃ§Ã£o para validaÃ§Ã£o de cÃ³digo de usuÃ¡rio
        function validateUserCode(code) {
            const validCodes = ['1234', '0000', '9999']; // Configurar cÃ³digos vÃ¡lidos
            return validCodes.includes(code);
        }
        
        // FunÃ§Ã£o para log de eventos para auditoria
        function logEvent(eventType, details) {
            const logEntry = {
                timestamp: new Date().toISOString(),
                type: eventType,
                details: details,
                clientCount: connectedSockets.size
            };
            
            const logMsg = {
                payload: {
                    type: 'event_log',
                    ...logEntry
                }
            };
            node.send(logMsg);
            
            node.log(`[LOG] ${eventType}: ${JSON.stringify(details)}`);
        }
        
        // FunÃ§Ã£o para enviar comando para todos os clientes conectados
        function sendAlarmCommand(command, commandName, userCode = null) {
            // Validar cÃ³digo de usuÃ¡rio se fornecido
            if (userCode && !validateUserCode(userCode)) {
                node.warn(`CÃ³digo de usuÃ¡rio invÃ¡lido para comando ${commandName}`);
                logEvent('INVALID_CODE', { command: commandName, code: '***' });
                
                const errorMsg = {
                    payload: {
                        type: 'error',
                        message: 'CÃ³digo de usuÃ¡rio invÃ¡lido',
                        command: commandName,
                        timestamp: new Date().toISOString()
                    }
                };
                node.send(errorMsg);
                return false;
            }
            
            if (connectedSockets.size === 0) {
                node.warn(`Nenhum cliente conectado para enviar comando ${commandName}`);
                logEvent('NO_CLIENT', { command: commandName });
                return false;
            }
            
            let successCount = 0;
            connectedSockets.forEach(socket => {
                if (!socket.destroyed) {
                    const clientStartByte = clientStartBytes.get(socket) || 0x7B;
                    const commandMessage = createResponseMessage([clientStartByte, ...command]);
                    
                    socket.write(commandMessage, (err) => {
                        if (err) {
                            node.error(`Erro ao enviar ${commandName} para ${socket.remoteAddress}: ${err.message}`);
                            logEvent('COMMAND_ERROR', { 
                                command: commandName, 
                                client: socket.remoteAddress, 
                                error: err.message 
                            });
                        } else {
                            node.log(`${commandName} enviado para ${socket.remoteAddress}: ${commandMessage.toString('hex')}`);
                            successCount++;
                            logEvent('COMMAND_SENT', { 
                                command: commandName, 
                                client: socket.remoteAddress,
                                success: true
                            });
                        }
                    });
                }
            });
            
            // Enviar dados para saÃ­da do nÃ³
            const msg = {
                payload: {
                    type: 'command',
                    command: commandName,
                    sent: 'varia por cliente',
                    sentBytes: command.length + 2,
                    timestamp: new Date().toISOString(),
                    clientCount: connectedSockets.size,
                    successCount: successCount,
                    userCode: userCode ? '***' : null
                }
            };
            node.send(msg);
            
            node.status({
                fill: successCount > 0 ? "blue" : "red", 
                shape: "dot", 
                text: `${commandName} ${successCount}/${connectedSockets.size}`
            });
            
            return successCount > 0;
        }
        
        // FunÃ§Ãµes especÃ­ficas para cada comando
        function armAway() {
            return sendAlarmCommand(alarmCommands.armAway, 'ARM_AWAY');
        }
        
        function armStay() {
            return sendAlarmCommand(alarmCommands.armStay, 'ARM_STAY');
        }
        
        function disarm(code = null) {
            let command;
            let commandName = 'DISARM';
            
            if (code) {
                if (!validateUserCode(code)) {
                    const errorMsg = {
                        payload: {
                            type: 'error',
                            message: 'CÃ³digo de usuÃ¡rio invÃ¡lido',
                            timestamp: new Date().toISOString()
                        }
                    };
                    node.send(errorMsg);
                    return false;
                }
                
                command = alarmCommands.disarm;
                commandName = `DISARM_CODE`;
            } else {
                command = alarmCommands.disarm;
            }
            
            return sendAlarmCommand(command, commandName, code);
        }
        
        // FunÃ§Ã£o para processar eventos de pacotes de 24 bytes
        function processEvent24(data) {
            let eventInfo = {
                evento: '',
                previousState: JSON.parse(JSON.stringify(currentAlarmState)),
                armed_away: currentAlarmState.armed_away,
                armed_night: currentAlarmState.armed_night,
                armed_home: currentAlarmState.armed_home,
                alarm_sounding: currentAlarmState.alarm_sounding,
                fire_alarm: currentAlarmState.fire_alarm,
                eletrificador: currentAlarmState.eletrificador,
                state: currentAlarmState.state,
                zone: null,
                user: null,
                description: ''
            };
            
            // Extrair evento dos bytes 8-11 (4 bytes ASCII)
            if (data.length >= 12) {
                eventInfo.evento = data.slice(8, 12).toString('ascii');
                
                // Extrair zona (se aplicÃ¡vel)
                if (data.length >= 16) {
                    eventInfo.zone = data.slice(12, 16).toString('ascii');
                }
                
                // Processar eventos conforme a lÃ³gica expandida
                switch (eventInfo.evento) {
                    // Eventos de armamento
                    case '3441':
                        eventInfo.armed_away = true;
                        eventInfo.armed_night = false;
                        eventInfo.armed_home = false;
                        eventInfo.state = 'ARMED_STAY';
                        eventInfo.description = 'Sistema armado parcialmente';
                        break;
                        
                    case '3401':
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.armed_home = true;
                        eventInfo.state = 'ARMED_HOME';
                        eventInfo.description = 'Sistema armado';
                        break;
                    case '3407':
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.armed_home = true;
                        eventInfo.state = 'ARMED_HOME';
                        eventInfo.description = 'Sistema armado';
                        break;
                    case '3403':
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.armed_home = true;
                        eventInfo.state = 'ARMED_HOME';
                        eventInfo.description = 'Autoarme por horário programado';
                        break;
                    case '3404':
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.armed_home = true;
                        eventInfo.state = 'ARMED_HOME';
                        eventInfo.description = 'Autoarme por não movimento';
                        break;
                    case '3408':
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.armed_home = true;
                        eventInfo.state = 'ARMED_HOME';
                        eventInfo.description = 'Arme rápido';
                        break;
                    case '3409':
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.armed_home = true;
                        eventInfo.state = 'ARMED_HOME';
                        eventInfo.description = 'Sistema armado totalmente';
                        if (eventInfo.evento === '3407') {
                            eventInfo.eletrificador = true;
                            eventInfo.description += ' com eletrificador';
                        }
                        break;
                        
                    // Eventos de desarmamento
                    case '1401':
                        eventInfo.armed_home = false;
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.alarm_sounding = false;
                        eventInfo.fire_alarm = false;
                        eventInfo.eletrificador = false;
                        eventInfo.state = 'DISARMED';
                        eventInfo.description = 'Sistema desarmado';
                        break;
                    case '1407':
                        eventInfo.armed_home = false;
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.alarm_sounding = false;
                        eventInfo.fire_alarm = false;
                        eventInfo.eletrificador = false;
                        eventInfo.state = 'DISARMED';
                        eventInfo.description = 'Desarme remoto';
                        break;
                    case '1403':
                        eventInfo.armed_home = false;
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.alarm_sounding = false;
                        eventInfo.fire_alarm = false;
                        eventInfo.eletrificador = false;
                        eventInfo.state = 'DISARMED';
                        eventInfo.description = 'Auto-desarme por horário programado';
                        break;
                    case '1409':
                        eventInfo.armed_home = false;
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.alarm_sounding = false;
                        eventInfo.fire_alarm = false;
                        eventInfo.eletrificador = false;
                        eventInfo.state = 'DISARMED';
                        eventInfo.description = 'Desarme por controle remoto ou entrada LIGA';
                        break;
                        
                    case '1100':
                        eventInfo.armed_home = false;
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.alarm_sounding = false;
                        eventInfo.fire_alarm = false;
                        eventInfo.medical_alarm=true;
                        eventInfo.eletrificador = false;
                        eventInfo.state = 'DISARMED';
                        eventInfo.description = 'Emergencia Médica';
                        break;
                    case '1101':
                        eventInfo.armed_home = false;
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.alarm_sounding = false;
                        eventInfo.fire_alarm = true;
                        eventInfo.medical_alarm=false;
                        eventInfo.eletrificador = false;
                        eventInfo.state = 'DISARMED';
                        eventInfo.description = 'Emergencia Médica';
                        break;
                    case '1102':
                        eventInfo.armed_home = false;
                        eventInfo.armed_away = false;
                        eventInfo.armed_night = false;
                        eventInfo.alarm_sounding = false;
                        eventInfo.fire_alarm = false;
                        eventInfo.medical_alarm = true;
                        eventInfo.panic = true;
                        eventInfo.eletrificador = false;
                        eventInfo.state = 'DISARMED';
                        eventInfo.description = 'Panico';
                        break;
                    case '1103':
                    case '1104':
                    case '1105':
                    case '1106':
                    case '1107':
                    case '1108':
                    case '1109':
                        if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.alarm_sounding = true;
                            eventInfo.state = 'ALARM_SOUNDING';
                            eventInfo.description = `Alarme zona ${eventInfo.zone}`;
                        }
                        break;
                        
                    // Eventos de incÃªndio
                    case '1130':
                         if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Disparo de zona';
                         }    
                        break;
                    case '1134':
                         if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Disparo de zona';
                         }                          break;
                    case '1137':
                        if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Alarme de zona tipo tamper';
                        }
                        break;
                    case '3130':
                        if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Restauração do disparo da zona';
                        }
                        break;
                    case '3134':
                        if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'estauração do alarme de porta aberta';
                        }
                        break;
                    case '3137':
                        if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Restauração do alrme de zona tipo tamper';
                        }
                        break;
                        
                    // Eventos de zona
                    case '1300':
                    case '1301':
                    case '1302':
                    case '1303':
                    case '1304':
                    case '1305':
                    case '1306':
                    case '1307':
                    case '1308':
                    case '1309':
                        eventInfo.description = `Zona ${eventInfo.zone} violada`;
                        break;
                        
                    case '3300':
                    case '3301':
                    case '3302':
                    case '3303':
                    case '3304':
                    case '3305':
                    case '3306':
                    case '3307':
                    case '3308':
                    case '3309':
                        eventInfo.description = `Zona ${eventInfo.zone} restaurada`;
                        break;
                        
                    // Eventos de bateria
                    case '1384':
                        eventInfo.description = 'Bateria baixa';
                        break;
                        
                    case '3384':
                        eventInfo.description = 'Bateria restaurada';
                        break;
                        
                    // Eventos de falha AC
                    case '1301':
                        eventInfo.description = 'Falha de energia AC';
                        break;
                        
                    case '3301':
                        eventInfo.description = 'Energia AC restaurada';
                        break;
                        
                    // Eventos de usuÃ¡rio
                    case '1422':
                        eventInfo.state = 'PGM acionada pelo usuÃ¡rio';
                        eventInfo.description = 'PGM acionada manualmente';
                        break;
                        
                    case '3422':
                        eventInfo.state = 'PGM desacionada pelo usuÃ¡rio';
                        eventInfo.description = 'PGM desacionada manualmente';
                        break;
                        
                    // Teste periÃ³dico
                    case '1602':
                        eventInfo.state = 'Teste Periodico';
                        eventInfo.description = 'Teste periÃ³dico realizado';
                        break;
                        
                    default:
                        eventInfo.state = 'UNKNOWN_EVENT';
                        eventInfo.description = `Evento desconhecido: ${eventInfo.evento}`;
                }
                
                // Atualizar estado atual
                currentAlarmState = {
                    armed_away: eventInfo.armed_away,
                    armed_night: eventInfo.armed_night,
                    armed_home: eventInfo.armed_home,
                    alarm_sounding: eventInfo.alarm_sounding,
                    fire_alarm: eventInfo.fire_alarm,
                    eletrificador: eventInfo.eletrificador,
                    state: eventInfo.state
                };
                
                node.log(`Evento processado: ${eventInfo.evento} - ${eventInfo.description}`);
            }
            
            return eventInfo;
        }
        
        // FunÃ§Ã£o para processar mensagens de entrada (comandos)
        node.on('input', function(msg) {
            if (msg.payload && typeof msg.payload === 'object' && msg.payload.command) {
                const command = msg.payload.command.toUpperCase();
                const code = msg.payload.code;
                
                switch(command) {
                    case 'ARM_AWAY':
                        armAway();
                        break;
                    case 'ARM_STAY':
                        armStay();
                        break;
                    case 'DISARM':
                        disarm(code);
                        break;
                    case 'GET_STATE':
                        const stateMsg = {
                            payload: {
                                type: 'current_state',
                                ...currentAlarmState,
                                timestamp: new Date().toISOString()
                            }
                        };
                        node.send(stateMsg);
                        break;
                    case 'CLEAR_ALERTS':
                        const clearMsg = {
                            payload: {
                                type: 'clear_alerts',
                                timestamp: new Date().toISOString()
                            }
                        };
                        node.send(clearMsg);
                        break;
                    default:
                        node.warn(`Comando nÃ£o reconhecido: ${command}`);
                        node.warn(`Comandos disponÃ­veis: ARM_AWAY, ARM_STAY, DISARM, GET_STATE, CLEAR_ALERTS`);
                }
            } else if (msg.payload && typeof msg.payload === 'string') {
                const command = msg.payload.toUpperCase();
                
                switch(command) {
                    case 'ARM_AWAY':
                        armAway();
                        break;
                    case 'ARM_STAY':
                        armStay();
                        break;
                    case 'DISARM':
                        disarm();
                        break;
                    case 'GET_STATE':
                        const stateMsg = {
                            payload: {
                                type: 'current_state',
                                ...currentAlarmState,
                                timestamp: new Date().toISOString()
                            }
                        };
                        node.send(stateMsg);
                        break;
                    default:
                        node.warn(`Comando nÃ£o reconhecido: ${command}`);
                        node.warn(`Comandos disponÃ­veis: ARM_AWAY, ARM_STAY, DISARM, GET_STATE`);
                }
            }
        });
        
        // FunÃ§Ã£o para enviar keep alive para todos os clientes conectados
        function sendKeepAlive() {
            if (connectedSockets.size > 0) {
                connectedSockets.forEach(socket => {
                    if (!socket.destroyed) {
                        const clientStartByte = clientStartBytes.get(socket) || 0x7B;
                        const keepAliveMessage = createResponseMessage([clientStartByte, 0x06, 0x01, 0x40, 0x01]);
                        
                        socket.write(keepAliveMessage, (err) => {
                            if (err) {
                                node.error(`Erro ao enviar keep alive para ${socket.remoteAddress}: ${err.message}`);
                            } else {
                                node.log(`Keep alive enviado para ${socket.remoteAddress}: ${keepAliveMessage.toString('hex')}`);
                            }
                        });
                    }
                });
                
                const msg = {
                    payload: {
                        type: 'keepalive',
                        sent: 'varia por cliente',
                        sentBytes: 6,
                        timestamp: new Date().toISOString(),
                        clientCount: connectedSockets.size
                    }
                };
                node.send(msg);
                
                node.status({fill:"green", shape:"dot", text:`keep alive enviado (${connectedSockets.size} clientes)`});
            }
        }
        // FunÃ§Ã£o para solicitar status da central
        function sendGetState() {
            if (connectedSockets.size > 0) {
                connectedSockets.forEach(socket => {
                    if (!socket.destroyed) {
                        const clientStartByte = clientStartBytes.get(socket) || 0x7B;
                        const getStateMessage = createResponseMessage([clientStartByte, 0x05, 0x01, 0x4d]);
                        
                        socket.write(getStateMessage, (err) => {
                            if (err) {
                                node.error(`Erro ao solicitar o status para ${socket.remoteAddress}: ${err.message}`);
                            } else {
                                node.log(`Solicitacao de status  enviado para ${socket.remoteAddress}: ${getStateMessage.toString('hex')}`);
                            }
                        });
                    }
                });
                
                const msg = {
                    payload: {
                        type: 'getState',
                        sent: 'Varia por cliente',
                        sentBytes: 5,
                        timestamp: new Date().toISOString(),
                        clientCount: connectedSockets.size
                    }
                };
                node.send(msg);
                
                node.status({fill:"green", shape:"dot", text:`get State enviado (${connectedSockets.size} clientes)`});
            }
        }
        // FunÃ§Ã£o para processar pacotes baseado no tamanho
        function processPacket(data, socket) {
            const packetSize = data.length;
            let shouldRespond = false;
            let packetType = 'unknown';
            let msg = [];
            let additionalData = {};
            
            const startByte = data.length > 0 ? data[0] : 0x7B;
            clientStartBytes.set(socket, startByte);
            
            if (packetSize === 5) {
                shouldRespond = true;
                packetType = 'heartbeat';
                msg = [startByte, 0x06, 0x01, 0x40, 0x01];
            } else if (packetSize === 24) {
                shouldRespond = true;
                packetType = 'event_24';
                
                const eventData = processEvent24(data);
                additionalData = eventData;
                
                msg = [startByte, 0x0A, 0x01, 0x24, 0x01, data[17], data[18], data[19], data[20]];
            } else if (packetSize === 102) {
                shouldRespond = true;
                packetType = 'status_102';
                const modelInfo = identifyModel(data);
                additionalData = {
                    modelo: modelInfo.modelo,
                    temEletrificador: modelInfo.temEletrificador,
                    Zonas: modelInfo.numZonas,
                    modelByte: data[41].toString(16).toUpperCase().padStart(2, '0')
                };
                //particoes = ord(chr(data[51]));
                //eletrificador = false if '00' in f'{data[54]:0>2X}' else True;
                msg = [startByte, 0x07, 0x01, 0x21, 0x01, 0x01];
                node.log(`Modelo identificado: ${modelInfo.modelo} (0x${additionalData.modelByte}) - Eletrificador: ${modelInfo.temEletrificador} - Zonas: ${modelInfo.numZonas}`);
                //msg = initializePgms();
                //node.log(msg);
                initializeZonas();
                //msg = initializeEletrificador();
                //node.log(msg);
                //msg = initializeSensors();
                //node.log(msg);
                //msg = initializeParticoes();
                //node.log(msg);
            
            

            } else if (packetSize >= 118) {
                packetType = 'status_118';
                let processedZones = [];
                let zona = 1;
                 
                node.warn("Processando pacote 118 bytes");
                // Processa 50 bytes a partir da posiÃ§Ã£o 31
                for (let i = 0; i < 50; i++) {
                   if (zona > numZonas) break;
                      const byteData = data[31 + i];
                      // Extrai nibbles (4 bits superiores e 4 bits inferiores)
                      const high = (byteData >> 4) & 0x0F;  // 4 bits superiores
                      const low = byteData & 0x0F;          // 4 bits inferiores
                     // Processa o nibble superior (high)
                     if (zona <= numZonas) {
                         const result = setZoneStatus(zona, high);
                         processedZones.push({
                           zona: zona,
                           nibble: 'high',
                           byteIndex: 31 + i,
                           rawValue: high,
                           result: result
                         });
                         zona++;
                     }
                     // Processa o nibble inferior (low)  
                     if (zona <= numZonas) {
                       const result = setZoneStatus(zona, low);
                       processedZones.push({
                         zona: zona,
                         nibble: 'low', 
                         byteIndex: 31 + i,
                         rawValue: low,
                         result: result
                      });
                      zona++;
                   }
                  if (zona > numZonas) break;
               }
                shouldRespond = true;
                msg = [startByte, 0x06, 0x01, 0x40, 0x01];
            } else {
                shouldRespond = true;
                packetType = 'invalid';
                node.warn(`Tamanho de pacote nÃ£o suportado: ${packetSize} bytes`);
                msg = [startByte, 0x06, 0x01, 0x40, 0x01];
            }
                        
            if (shouldRespond) {
                const responseMessage = createResponseMessage(msg);
                
                socket.write(responseMessage, (err) => {
                    if (err) {
                        node.error(`Erro ao enviar resposta: ${err.message}`);
                    } else {
                        node.log(`Resposta enviada para pacote ${packetType} (${packetSize} bytes): ${responseMessage.toString('hex')}`);
                    }
                });
                
                const outputMsg = {
                    payload: {
                        type: packetType,
                        received: data.toString('hex'),
                        sent: responseMessage.toString('hex'),
                        receivedBytes: packetSize,
                        sentBytes: responseMessage.length,
                        timestamp: new Date().toISOString(),
                        clientIP: socket.remoteAddress,
                        clientPort: socket.remotePort,
                        zonas: zonas,
                        ...additionalData
                    }
                };
                node.send(outputMsg);
                
                if (packetType === 'status_102' && additionalData.modelo) {
                    node.status({fill:"blue", shape:"dot", text:`${additionalData.modelo} processado`});
                } else if (packetType === 'event_24' && additionalData.evento) {
                    node.status({fill:"blue", shape:"dot", text:`Evento ${additionalData.evento} - ${additionalData.state}`});
                } else {
                    node.status({fill:"blue", shape:"dot", text:`${packetType} processado`});
                }
            }
            
            return shouldRespond;
        }
        
        // Criar servidor TCP
        try {
            server = net.createServer((socket) => {
                connectedSockets.add(socket);
                node.status({fill:"green", shape:"dot", text:`${connectedSockets.size} cliente(s) conectado(s)`});
                node.log(`Cliente conectado: ${socket.remoteAddress}:${socket.remotePort}`);
                
                socket.on('data', (data) => {
                    node.log(`Dados recebidos de ${socket.remoteAddress}: ${data.length} bytes - ${data.toString('hex')}`);
                    processPacket(data, socket);
                });
                
                socket.on('close', () => {
                    connectedSockets.delete(socket);
                    clientStartBytes.delete(socket);
                    node.log(`Cliente desconectado: ${socket.remoteAddress}`);
                    
                    if (connectedSockets.size > 0) {
                        node.status({fill:"green", shape:"dot", text:`${connectedSockets.size} cliente(s) conectado(s)`});
                    } else {
                        node.status({fill:"yellow", shape:"ring", text:"aguardando conexÃ£o"});
                    }
                });
                
                socket.on('error', (err) => {
                    node.error(`Erro no socket ${socket.remoteAddress}: ${err.message}`);
                    connectedSockets.delete(socket);
                    clientStartBytes.delete(socket);
                    node.status({fill:"red", shape:"ring", text:"erro socket"});
                });
            });
            
            server.listen(port, host, () => {
                node.log(`Servidor JFL iniciado em ${host}:${port}`);
                node.status({fill:"yellow", shape:"ring", text:`escutando :${port}`});
                
                if (config.enableKeepAlive !== false) {
                    keepAliveTimer = setInterval(sendKeepAlive, keepAliveInterval);
                    node.log(`Keep alive iniciado: ${keepAliveInterval}ms`);
                }
                if (config.enableGetState !== false) {
                    getStateTimer = setInterval(sendGetState, getStateInterval);
                    node.log(`Get State iniciado: ${getStateInterval}ms`);
                }
            });
            
            server.on('error', (err) => {
                node.error(`Erro no servidor: ${err.message}`);
                node.status({fill:"red", shape:"ring", text:"erro servidor"});
            });
            
        } catch (err) {
            node.error(`Erro ao criar servidor: ${err.message}`);
            node.status({fill:"red", shape:"ring", text:"erro init"});
        }
        
        // Cleanup
        node.on('close', (done) => {
            if (keepAliveTimer) {
                clearInterval(keepAliveTimer);
                keepAliveTimer = null;
                node.log('Keep alive timer parado');
            }
            if (getStateTimer) {
                clearInterval(getStateTimer);
                getStateTimer = null;
                node.log('Get State  timer parado');
            }
            currentAlarmState = {
                armed_away: false,
                armed_night: false,
                armed_home: false,
                alarm_sounding: false,
                fire_alarm: false,
                eletrificador: false,
                state: 'DISARMED'
            };
            
            connectedSockets.forEach(socket => {
                if (!socket.destroyed) {
                    socket.destroy();
                }
            });
            connectedSockets.clear();
            clientStartBytes.clear();
            
            if (server) {
                server.close(() => {
                    node.log('Servidor JFL fechado');
                    done();
                });
            } else {
                done();
            }
        });
    }
    
    RED.nodes.registerType("alarme-jfl", AlarmeJFLNode);
};
