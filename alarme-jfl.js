// alarme-jfl.js - Versão com comandos PGM
module.exports = function(RED) {
    "use strict";
    
    function AlarmeJFLNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const net = require('net');
        let server = null;
        let pgms = {};
        let particoes = {};
        let numZonas = null;
        let numPgms = null;
        let numParticoes = null;
        let sensors = {};
        let zonas = {};
        
        // Configurações
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
        
        // Códigos de comando para o alarme
        const alarmCommands = {
            armAway: [0x06, 0x01, 0x4E, 0x01],
            armStay: [0x06, 0x01, 0x53, 0x01],
            disarm: [0x06, 0x01, 0x4F, 0x01],
            // Comandos PGM adicionados (sem o último byte - será calculado o checksum)
            pgmOn: [0x07, 0x01, 0x01, 0x50], // + pgm_number (checksum será calculado)
            pgmOff: [0x07, 0x01, 0x01, 0x51], // + pgm_number (checksum será calculado)
        };
        
        // Função para calcular checksum XOR
        function calculateChecksum(buffer) {
            let checksum = 0;
            for (let i = 0; i < buffer.length; i++) {
                checksum ^= buffer[i];
            }
            return checksum;
        }
        
        // Função para criar mensagem de resposta padrão
        function createResponseMessage(msg) {
            const baseMessage = Buffer.from(msg);
            const checksum = calculateChecksum(baseMessage);
            return Buffer.concat([baseMessage, Buffer.from([checksum])]);
        }
        
        // Função para identificar modelo da central baseado no byte 41
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
                    numPgms = 4;
                    numParticoes = 4;
                    numZonas = 32;
                    break;
                case 'A1':
                    modelo = 'Active 20 Ultra/GPRS';
                    temEletrificador = true;
                    numPgms = 4;
                    numParticoes = 2;
                    numZonas = 22;
                    break;
                case 'A2':
                    modelo = 'Active 8 Ultra';
                    temEletrificador = false;
                    numPgms = 0;
                    numParticoes = 2;
                    numZonas = 12;
                    break;
                case 'A3':
                    modelo = 'Active 20 Ethernet';
                    temEletrificador = true;
                    numPgms = 4;
                    numParticoes = 2;
                    numZonas = 22;
                    break;
                case 'A4':
                    modelo = 'Active 100 Bus';
                    temEletrificador = true;
                    numPgms = 16;
                    numParticoes = 16;
                    numZonas = 99;
                    break;
                case 'A5':
                    modelo = 'Active 20 Bus';
                    temEletrificador = true;
                    numPgms = 16;
                    numParticoes = 2;
                    numZonas = 32;
                    break;
                case 'A6':
                    modelo = 'Active Full 32';
                    temEletrificador = false;
                    numPgms = 16;
                    numParticoes = 4;
                    numZonas = 32;
                    break;
                case 'A7':
                    modelo = 'Active 20';
                    temEletrificador = true;
                    numPgms = 4;
                    numParticoes = 2;
                    numZonas = 32;
                    break;
                case 'A8':
                    modelo = 'Active 8W';
                    temEletrificador = true;
                    numPgms = 4;
                    numParticoes = 2;
                    numZonas = 32;
                    break;
                case '4B':
                    modelo = 'M-300+';
                    temEletrificador = false;
                    numPgms = 4;
                    numParticoes = 0;
                    numZonas = 0;
                    break;
                case '5D':
                    modelo = 'M-300 Flex';
                    temEletrificador = false;
                    numPgms = 2;
                    numParticoes = 0;
                    numZonas = 0;
                    break;
                default:
                    modelo = `Modelo não identificado (0x${modelHex})`;
                    temEletrificador = false;
                    numZonas = 0;
                    numPgms = 0;
                    numParticoes = 0;
            }
            
            return { modelo, temEletrificador, numZonas, numPgms, numParticoes };
        }

        // Função para atualizar as zonas
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
        
        // Função para atualizar sensor de bateria
        function setBatteryStatus(batteryByte) {
           // Função para interpretar nível da bateria
             function interpretBatteryLevel(batteryByte) {
               let percentage;
               let description;
               if (batteryByte >= 240) {
                  percentage = 100;
                  description = "Bateria carregada";
               } else if (batteryByte >= 200) {
                 percentage = 80;
                 description = "Bateria boa";
               } else if (batteryByte >= 150) {
                 percentage = 60;
                 description = "Bateria média";
               } else if (batteryByte >= 100) {
                 percentage = 40;
                 description = "Bateria baixa";
               } else if (batteryByte >= 50) {
                 percentage = 20;
                 description = "Bateria muito baixa";
               } else {
                 percentage = 0;
                 description = "Bateria crítica";
               }
               return { percentage, description };
             }
            const batteryInfo = interpretBatteryLevel(batteryByte);
            sensors['bateria'] = {
              name: "Bateria",
              state: batteryInfo.percentage,
              device_class: "BATTERY",
              description: batteryInfo.description,
              raw_value: batteryByte
           };
       }
        
        // Função para atualizar as PGMs (corrigido)
        function setPgmStatus(byteValue, posicao) {
            const binary = byteValue.toString(2).padStart(8, '0'); // Converte para binário de 8 bits
            for (let i = 0; i < 8; i++) {
                let pgmNumber;
                if (posicao === 116) {
                    // Byte 116: PGMs 9-16
                    pgmNumber = 9 + i;
                } else {
                    // Byte 13: PGMs 1-8
                    pgmNumber = 1 + i;
                }
                
                const pgmId = `pgm_${pgmNumber}`;
                // Verifica se o PGM existe
                if (pgms[pgmId] && pgmNumber <= numPgms) {
                    const bit = parseInt(binary[7-i]); // Lê da direita para esquerda (bit0 = posição 7)
                    const newState = bit > 0 ? "STATE_ON" : "STATE_OFF";
                    pgms[pgmId] = {
                        name: `Pgm ${pgmNumber}`,
                        type: "toggle",
                        tipo: "PGM",
                        state: newState,
                        switch_number: pgmNumber
                    };
                }
            }
        }
        
        // Função para inicializar as zonas
        function initializeZonas() {
            node.warn('Inicializando as zonas da central');
            for (let i = 0; i < numZonas; i++) {
                const zonaId = `zona_${i + 1}`;
                zonas[zonaId] = {
                name: `Zona ${i + 1}`,
                state: false
               };
          }
          node.warn('Zonas da central inicializadas');
        }
        
        // Função para inicializar o eletrificador
        function initializeEletrificador() {
           node.warn('Inicializando eletrificador da central');
         }
        
        // Função para inicializar os sensores
        function initializeSensors() {
           node.warn('Inicializando os sensores da central');
           sensors['bateria'] = {
              name: "Bateria",
              state: null,
              device_class: "BATTERY"
            };
         }
        
        // Função para inicializar as partições
        function initializeParticoes() {
           node.warn('Inicializando as partições da central');
           for (let i = 0; i < numParticoes; i++) {
              const particaoId = `particao_${i + 1}`;
              sensors[particaoId] = {
                 name: `Particao ${i + 1}`,
                 state: "DISARMED",
                 device_class: "ENUM"
             };
           }
        } 
        
        // Função para inicializar as PGMs
        function initializePgms() {
           node.warn('Inicializando as PGMs da central');
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
        }
        
        // Função para validação de código de usuário
        function validateUserCode(code) {
            const validCodes = ['1234', '0000', '9999']; // Configurar códigos válidos
            return validCodes.includes(code);
        }
        
        // Função para log de eventos para auditoria
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
        
        // Função para enviar comando para todos os clientes conectados
        function sendAlarmCommand(command, commandName, userCode = null) {
            // Validar código de usuário se fornecido
            if (userCode && !validateUserCode(userCode)) {
                node.warn(`Código de usuário inválido para comando ${commandName}`);
                logEvent('INVALID_CODE', { command: commandName, code: '***' });
                
                const errorMsg = {
                    payload: {
                        type: 'error',
                        message: 'Código de usuário inválido',
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
            
            // Enviar dados para saída do nó
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
        
        // Funções específicas para cada comando de alarme
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
                            message: 'Código de usuário inválido',
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
        
        // NOVAS FUNÇÕES PARA CONTROLE DE PGM
        function pgmOn(pgmNumber) {
            // Validar número da PGM
            if (!pgmNumber || pgmNumber < 1 || pgmNumber > 16) {
                node.warn(`Número de PGM inválido: ${pgmNumber}. Deve ser entre 1 e 16`);
                const errorMsg = {
                    payload: {
                        type: 'error',
                        message: 'Número de PGM inválido. Deve ser entre 1 e 16',
                        pgm: pgmNumber,
                        timestamp: new Date().toISOString()
                    }
                };
                node.send(errorMsg);
                return false;
            }
            
            // Verificar se a PGM existe para o modelo da central
            if (pgmNumber > numPgms) {
                node.warn(`PGM ${pgmNumber} não existe neste modelo de central (máx: ${numPgms})`);
                const errorMsg = {
                    payload: {
                        type: 'error',
                        message: `PGM ${pgmNumber} não existe neste modelo de central (máximo: ${numPgms})`,
                        pgm: pgmNumber,
                        timestamp: new Date().toISOString()
                    }
                };
                node.send(errorMsg);
                return false;
            }
            
            // Converter número da PGM para hexadecimal
            // PGM 1 = 0x01, PGM 2 = 0x02, ..., PGM 10 = 0x0A, ..., PGM 16 = 0x10
            const pgmByte = parseInt(pgmNumber);
            const command = [...alarmCommands.pgmOn, pgmByte];
            
            node.log(`Comando PGM_ON para PGM ${pgmNumber}: [${command.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
            
            return sendAlarmCommand(command, `PGM_ON_${pgmNumber}`);
        }
        
        function pgmOff(pgmNumber) {
            // Validar número da PGM
            if (!pgmNumber || pgmNumber < 1 || pgmNumber > 16) {
                node.warn(`Número de PGM inválido: ${pgmNumber}. Deve ser entre 1 e 16`);
                const errorMsg = {
                    payload: {
                        type: 'error',
                        message: 'Número de PGM inválido. Deve ser entre 1 e 16',
                        pgm: pgmNumber,
                        timestamp: new Date().toISOString()
                    }
                };
                node.send(errorMsg);
                return false;
            }
            
            // Verificar se a PGM existe para o modelo da central
            if (pgmNumber > numPgms) {
                node.warn(`PGM ${pgmNumber} não existe neste modelo de central (máx: ${numPgms})`);
                const errorMsg = {
                    payload: {
                        type: 'error',
                        message: `PGM ${pgmNumber} não existe neste modelo de central (máximo: ${numPgms})`,
                        pgm: pgmNumber,
                        timestamp: new Date().toISOString()
                    }
                };
                node.send(errorMsg);
                return false;
            }
            
            // Converter número da PGM para hexadecimal
            // PGM 1 = 0x01, PGM 2 = 0x02, ..., PGM 10 = 0x0A, ..., PGM 16 = 0x10
            const pgmByte = parseInt(pgmNumber);
            const command = [...alarmCommands.pgmOff, pgmByte];
            
            node.log(`Comando PGM_OFF para PGM ${pgmNumber}: [${command.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
            
            return sendAlarmCommand(command, `PGM_OFF_${pgmNumber}`);
        }
        
        // Função para processar eventos de pacotes de 24 bytes
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
                
                // Extrair zona (se aplicável)
                if (data.length >= 16) {
                    eventInfo.zone = data.slice(12, 16).toString('ascii');
                }
                
                // Processar eventos conforme a lógica expandida
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
                        
                    // Eventos de PGM adicionados
                    case '1422':
                        eventInfo.description = 'PGM acionada pelo usuário';
                        break;
                        
                    case '3422':
                        eventInfo.description = 'PGM desacionada pelo usuário';
                        break;
                        
                    // Eventos de incêndio
                    case '1130':
                         if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Disparo de zona';
                         }    
                        break;
                    case '1134':
                         if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Disparo de zona';
                         }                          
                        break;
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
                            eventInfo.description = 'Restauração do alarme de porta aberta';
                        }
                        break;
                    case '3137':
                        if (eventInfo.armed_home || eventInfo.armed_away) {
                            eventInfo.description = 'Restauração do alarme de zona tipo tamper';
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
                        
                    // Teste periódico
                    case '1602':
                        eventInfo.state = 'Teste Periodico';
                        eventInfo.description = 'Teste periódico realizado';
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
        
        // Função para processar mensagens de entrada (comandos) - ATUALIZADA
        node.on('input', function(msg) {
            if (msg.payload && typeof msg.payload === 'object' && msg.payload.command) {
                const command = msg.payload.command.toUpperCase();
                const code = msg.payload.code;
                const pgmNumber = msg.payload.pgm || msg.payload.pgmNumber;
                
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
                    case 'PGM_ON':
                        if (pgmNumber) {
                            pgmOn(parseInt(pgmNumber));
                        } else {
                            node.warn('Comando PGM_ON requer o número da PGM (pgm ou pgmNumber)');
                            const errorMsg = {
                                payload: {
                                    type: 'error',
                                    message: 'Comando PGM_ON requer o número da PGM',
                                    timestamp: new Date().toISOString()
                                }
                            };
                            node.send(errorMsg);
                        }
                        break;
                    case 'PGM_OFF':
                        if (pgmNumber) {
                            pgmOff(parseInt(pgmNumber));
                        } else {
                            node.warn('Comando PGM_OFF requer o número da PGM (pgm ou pgmNumber)');
                            const errorMsg = {
                                payload: {
                                    type: 'error',
                                    message: 'Comando PGM_OFF requer o número da PGM',
                                    timestamp: new Date().toISOString()
                                }
                            };
                            node.send(errorMsg);
                        }
                        break;
                    case 'GET_STATE':
                        const stateMsg = {
                            payload: {
                                type: 'current_state',
                                ...currentAlarmState,
                                zonas: zonas,
                                sensores: sensors,
                                pgms: pgms,
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
                        node.warn(`Comando não reconhecido: ${command}`);
                        node.warn(`Comandos disponíveis: ARM_AWAY, ARM_STAY, DISARM, PGM_ON, PGM_OFF, GET_STATE, CLEAR_ALERTS`);
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
                                zonas: zonas,
                                sensores: sensors,
                                pgms: pgms,
                                timestamp: new Date().toISOString()
                            }
                        };
                        node.send(stateMsg);
                        break;
                    default:
                        node.warn(`Comando não reconhecido: ${command}`);
                        node.warn(`Comandos disponíveis: ARM_AWAY, ARM_STAY, DISARM, GET_STATE`);
                        node.warn(`Para comandos PGM use objeto: {command: "PGM_ON", pgm: 1}`);
                }
            }
        });
        
        // Função para enviar keep alive para todos os clientes conectados
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
        
        // Função para solicitar status da central
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
                                node.log(`Solicitacao de status enviado para ${socket.remoteAddress}: ${getStateMessage.toString('hex')}`);
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
        
        // Função para processar pacotes baseado no tamanho
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
                
                msg = [startByte, 0x07, 0x01, 0x21, 0x01, 0x01];
                node.log(`Modelo identificado: ${modelInfo.modelo} (0x${additionalData.modelByte}) - Eletrificador: ${modelInfo.temEletrificador} - Zonas: ${modelInfo.numZonas}`);
                
                initializeZonas();
                initializeEletrificador();
                initializeSensors();
                initializeParticoes();
                initializePgms();

            } else if (packetSize >= 118) {
                packetType = 'status_118';
                let processedZones = [];
                let zona = 1;
                 
                node.warn("Processando pacote 118 bytes");
                // processa 1 byte na posicao 12;
                setBatteryStatus(data[12]);
                
                // Processa status das PGMs nos bytes corretos
                // Byte 13: PGMs 1-8 (bit0 = PGM1, bit1 = PGM2, ..., bit7 = PGM8)
                setPgmStatus(data[13], 13);
                
                // Byte 116: PGMs 9-16 (bit0 = PGM9, bit1 = PGM10, ..., bit7 = PGM16)
                if (numPgms > 8 && data.length > 116) {
                    setPgmStatus(data[116], 116);
                }
                
                // Processa 50 bytes a partir da posição 31
                for (let i = 0; i < 50; i++) {
                   if (zona > numZonas) break;
                      const byteData = data[31 + i];
                      // Extrai nibbles (4 bits superiores e 4 bits inferiores)
                      const high = (byteData >> 4) & 0x0F;  // 4 bits superiores
                      const low = byteData & 0x0F;          // 4 bits inferiores
                     // Processa o nibble superior (high)
                     if (zona <= numZonas) {
                         const result = setZoneStatus(zona, high);
                         zona++;
                     }
                     // Processa o nibble inferior (low)  
                     if (zona <= numZonas) {
                       const result = setZoneStatus(zona, low);
                       zona++;
                   }
                  if (zona > numZonas) break;
               }
                shouldRespond = true;
                msg = [startByte, 0x06, 0x01, 0x40, 0x01];
            } else {
                shouldRespond = true;
                packetType = 'invalid';
                node.warn(`Tamanho de pacote não suportado: ${packetSize} bytes`);
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
                        sensores: sensors,
                        pgms: pgms,
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
                        node.status({fill:"yellow", shape:"ring", text:"aguardando conexão"});
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
                node.log('Get State timer parado');
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
