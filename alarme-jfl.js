// alarme-jfl.js
module.exports = function(RED) {
    "use strict";
    
    function AlarmeJFLNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const net = require('net');
        let server = null;
        
        // Configurações
        const port = parseInt(config.port) || 9999;
        const host = config.host || '0.0.0.0';
        const keepAliveInterval = parseInt(config.keepAliveInterval) || 30000; // 30 segundos padrão
        
        let keepAliveTimer = null;
        let connectedSockets = new Set();
        
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
        
        // Função para enviar keep alive para todos os clientes conectados
        function sendKeepAlive() {
            if (connectedSockets.size > 0) {
                const keepAliveMessage = createResponseMessage([0x7B, 0x06, 0x01, 0x40, 0x01]);
                connectedSockets.forEach(socket => {
                    if (!socket.destroyed) {
                        socket.write(keepAliveMessage, (err) => {
                            if (err) {
                                node.error(`Erro ao enviar keep alive para ${socket.remoteAddress}: ${err.message}`);
                            } else {
                                node.log(`Keep alive enviado para ${socket.remoteAddress}: ${keepAliveMessage.toString('hex')}`);
                            }
                        });
                    }
                });
                
                // Enviar dados para saída do nó
                const msg = {
                    payload: {
                        type: 'keepalive',
                        sent: keepAliveMessage.toString('hex'),
                        sentBytes: keepAliveMessage.length,
                        timestamp: new Date().toISOString(),
                        clientCount: connectedSockets.size
                    }
                };
                node.send(msg);
                
                node.status({fill:"green", shape:"dot", text:`keep alive enviado (${connectedSockets.size} clientes)`});
            }
        }
        
        // Função para processar pacotes baseado no tamanho
        function processPacket(data, socket) {
            const packetSize = data.length;
            let shouldRespond = false;
            let packetType = 'unknown';
            
            // Determinar tipo de pacote baseado no tamanho
            if (packetSize === 5) {
                shouldRespond = true;
                packetType = 'heartbeat';
            } else if (packetSize === 24) {
                shouldRespond = true;
                packetType = 'status_24';
            } else if (packetSize === 102) {
                shouldRespond = true;
                packetType = 'status_102';
                if (data[3] === 0x21) {
                } else {
                }
                msg=[0x7B, 0x07, 0x01, 0x21, 0x01,0x01];
 
            } else if (packetSize >= 118) {
                shouldRespond = true;
                packetType = 'extended_status';
                msg=[0x7B, 0x06, 0x01, 0x40, 0x01];
            } else {
                packetType = 'invalid';
                node.warn(`Tamanho de pacote não suportado: ${packetSize} bytes`);
                msg=[0x7B, 0x06, 0x01, 0x40, 0x01];
            }
                        
            if (shouldRespond) {
                // Criar e enviar resposta
                const responseMessage = createResponseMessage(msg]);
                
                socket.write(responseMessage, (err) => {
                    if (err) {
                        node.error(`Erro ao enviar resposta: ${err.message}`);
                    } else {
                        node.log(`Resposta enviada para pacote ${packetType} (${packetSize} bytes): ${responseMessage.toString('hex')}`);
                    }
                });
                
                // Enviar dados para saída do nó
                const msg = {
                    payload: {
                        type: packetType,
                        received: data.toString('hex'),
                        sent: responseMessage.toString('hex'),
                        receivedBytes: packetSize,
                        sentBytes: responseMessage.length,
                        timestamp: new Date().toISOString(),
                        clientIP: socket.remoteAddress,
                        clientPort: socket.remotePort
                    }
                };
                node.send(msg);
                
                node.status({fill:"blue", shape:"dot", text:`${packetType} processado`});
            }
            
            return shouldRespond;
        }
        
        // Criar servidor TCP
        try {
            server = net.createServer((socket) => {
                // Adicionar socket ao conjunto de clientes conectados
                connectedSockets.add(socket);
                node.status({fill:"green", shape:"dot", text:`${connectedSockets.size} cliente(s) conectado(s)`});
                node.log(`Cliente conectado: ${socket.remoteAddress}:${socket.remotePort}`);
                
                socket.on('data', (data) => {
                    node.log(`Dados recebidos de ${socket.remoteAddress}: ${data.length} bytes - ${data.toString('hex')}`);
                    processPacket(data, socket);
                });
                
                socket.on('close', () => {
                    // Remover socket do conjunto
                    connectedSockets.delete(socket);
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
                    node.status({fill:"red", shape:"ring", text:"erro socket"});
                });
            });
            
            server.listen(port, host, () => {
                node.log(`Servidor JFL iniciado em ${host}:${port}`);
                node.status({fill:"yellow", shape:"ring", text:`escutando :${port}`});
                
                // Iniciar keep alive timer
                if (config.enableKeepAlive !== false) { // Habilitado por padrão
                    keepAliveTimer = setInterval(sendKeepAlive, keepAliveInterval);
                    node.log(`Keep alive iniciado: ${keepAliveInterval}ms`);
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
            // Parar keep alive timer
            if (keepAliveTimer) {
                clearInterval(keepAliveTimer);
                keepAliveTimer = null;
                node.log('Keep alive timer parado');
            }
            
            // Fechar todas as conexões
            connectedSockets.forEach(socket => {
                if (!socket.destroyed) {
                    socket.destroy();
                }
            });
            connectedSockets.clear();
            
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
