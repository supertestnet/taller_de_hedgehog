var hedgehog_workshop = {
    faucet_usable: true,
    testnet_privkey: null,
    network_string: null,
    btc_privkey: null,
    btc_address: null,
    utxos: {},
    // relays: [ "ws://127.0.0.1:6969" ],
    relays: [ "wss://no.str.cr" ],
    channels_being_closed: {},
    txs_in_mempool: 0,
    unconfirmed_L1_balance: 0,
    confirmed_L1_balance: 0,
    unconfirmed_L2_balance: 0,
    confirmed_L2_balance: 0,
    isValidHex: hex => {
        if ( !hex ) return;
        var length = hex.length;
        if ( length % 2 ) return;
        try {
            var bigint = BigInt( "0x" + hex, "hex" );
        } catch( e ) {
            return;
        }
        var prepad = bigint.toString( 16 );
        var i; for ( i=0; i<length; i++ ) prepad = "0" + prepad;
        var padding = prepad.slice( -Math.abs( length ) );
        return ( padding === hex );
    },
    useFaucet: async ( amnt = 5_000_000 ) => {
        if ( !hedgehog_workshop.faucet_usable ) return;
        hedgehog_workshop.faucet_usable = false;
        var address = hedgehog_workshop.btc_address;
        var privkey = hedgehog_workshop.btc_privkey;
        var feerate = 1;
        var txhex = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "send", {destino: address, amnt, feerate} );
        var tx = tapscript.Tx.decode( txhex );
        var txid = tapscript.Tx.util.getTxid( txhex );
        var vout_i_seek = -1;
        var value_i_received = 0;
        tx.vout.forEach( ( output, index ) => {
            var address_that_got_money = tapscript.Address.fromScriptPubKey( output.scriptPubKey, hedgehog.network );
            if ( address_that_got_money !== address ) return;
            vout_i_seek = index;
            value_i_received = Number( output.value );
        });
    },
    getBalances: async () => {
        var address = hedgehog_workshop.btc_address;
        if ( !address ) return { confirmed_balance: 0, unconfirmed_balance: 0 }
        hedgehog_workshop.utxos = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "utxos", address );
        var confirmed_balance = 0;
        var unconfirmed_balance = 0;
        var i; for ( i=0; i<hedgehog_workshop.utxos.length; i++ ) {
            var utxo = hedgehog_workshop.utxos[ i ];
            var txid = utxo.txid;
            var vout = utxo.vout;
            var rawtx = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "rawtx", txid );
            var tx = tapscript.Tx.decode( rawtx );
            var output = tx.vout[ vout ];
            var address_that_got_money = tapscript.Address.fromScriptPubKey( output.scriptPubKey, hedgehog.network );
            if ( address_that_got_money !== address ) continue;
            if ( utxo.status.confirmed ) confirmed_balance = confirmed_balance + utxo.value;
            else unconfirmed_balance = unconfirmed_balance + utxo.value;
        }
        return { confirmed_balance, unconfirmed_balance }
    },
    spendCoins: async ( destino, amt, sats_per_byte, utxos, change_address ) => {
        var inputs = [];
        var outputs = [];
        var from_amount = 0;
        utxos.forEach( utxo => {
            from_amount = from_amount + utxo[ "value" ];
            var txid = utxo[ "txid" ];
            var vout = utxo[ "vout" ];
            var amount = utxo[ "value" ];
            inputs.push({
                txid: txid,
                vout: vout,
                prevout: {
                    value: amount,
                    scriptPubKey: tapscript.Address.toScriptPubKey( utxo[ "address" ] ),
                },
            });
        });
        if ( !from_amount ) return alert( "You cannot spend without money. Please make a deposit, then try again." );
        var to_amount = amt;
        var there_be_dust = false;
        outputs.push({
            value: to_amount,
            scriptPubKey: tapscript.Address.toScriptPubKey( destino ),
        });
        if ( to_amount < 330 ) there_be_dust = true;
        if ( there_be_dust ) return alert( "You cannot send less than 330 sats because that is bitcoin's dust limit. Please try again" );
        if ( from_amount - to_amount < 1 ) return alert( "You must leave enough to pay a mining fee, please try again" );
        var txsize = 0;
        inputs.forEach( item => txsize = txsize + 64 + 32 + 8 );
        var i; for ( i=0; i<outputs.length; i++ ) {
            //I calculate that outputs add 30 bytes apiece by
            //assuming the average scriptpubkey is 26 bytes
            //and assuming amounts are denoted in 4 bytes
            txsize = txsize + 30;
        }
        var mining_fee = txsize * sats_per_byte;
        if ( mining_fee < 172 ) mining_fee = 172;
        if ( from_amount - to_amount < mining_fee ) return alert( `With your chosen fee rate you must leave at least ${mining_fee} sats to pay for mining fees, which means the max you can spend is ${from_amount - mining_fee} sats. Please try again` );
        if ( from_amount - ( to_amount + mining_fee ) >= 330 ) {
            outputs.push({
                value: from_amount - ( to_amount + mining_fee ),
                scriptPubKey: tapscript.Address.toScriptPubKey( change_address ),
            });
        }
        var txdata = tapscript.Tx.create({
            vin: inputs,
            vout: outputs,
        });
        utxos.forEach( ( utxo, index ) => {
            var privkey = utxo[ "privkey" ];
            var sig = tapscript.Signer.taproot.sign( privkey, txdata, index );
            txdata.vin[ index ].witness = [ sig ];
        });
        var txhex = tapscript.Tx.encode( txdata ).hex;
        return txhex;
    },
    getStateOfChannels: async() => {
        var channels_to_remove = [];
        var channels_to_keep = {}

        //process all channels in state list
        var confirmed_L2_balance = 0;
        var unconfirmed_L2_balance = 0;
        var i; for ( i=0; i<Object.keys( hedgehog.state ).length; i++ ) {
            var chan_id = Object.keys( hedgehog.state )[ i ];

            //if any channel got closed, mark that channel for removal
            var channel_utxos = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "utxos", hedgehog.state[ chan_id ].multisig );
            var channel_ceased = true;
            var channel_is_confirmed = false;
            channel_utxos.forEach( utxo => {
                if ( utxo.txid !== hedgehog.state[ chan_id ].multisig_utxo_info.txid ) return;
                if ( utxo.status.confirmed ) channel_is_confirmed = true;
                channel_ceased = false;
            });
            if ( channel_ceased ) {
                channels_to_remove.push( chan_id );
                continue;
            }

            //otherwise, update the total balance and mark the channel for keeping
            var channel_balance = hedgehog.state[ chan_id ].alices_privkey ? hedgehog.state[ chan_id ].balances[ 0 ] || 0 : hedgehog.state[ chan_id ].balances[ 1 ] || 0;
            if ( channel_is_confirmed ) confirmed_L2_balance = confirmed_L2_balance + channel_balance;
            else unconfirmed_L2_balance = unconfirmed_L2_balance + channel_balance;
            channels_to_keep[ chan_id ] = channel_balance;
        }

        hedgehog_workshop.confirmed_L2_balance = confirmed_L2_balance;
        hedgehog_workshop.unconfirmed_L2_balance = unconfirmed_L2_balance;

        var closing_channels = {}

        //process all closing channels
        var i; for ( i=0; i<Object.keys( hedgehog_workshop.channels_being_closed ).length; i++ ) {
            var chan_id = Object.keys( hedgehog_workshop.channels_being_closed )[ i ];
            var channel_data = hedgehog_workshop.channels_being_closed[ chan_id ];

            //prepare variables
            var money_coming_to_you = channel_data.money_coming_to_you;
            var tx_to_broadcast = null;
            var type_of_tx = null;
            var waiting_for = null;
            var blockheight = null;
            var awaited_blockheight = null;
            var potential_extra_money = null;
            var extra_awaited_blockheight = null;
            if ( channel_data.hasOwnProperty( "force_close_txs" ) ) {
                tx_to_broadcast = channel_data.force_close_txs[ 1 ];
                type_of_tx = "finalization_tx";
                blockheight = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "blockheight" );
                var txid_of_tx0 = channel_data.txid_of_tx0;
                var revocable_address = channel_data.revocable_address;
                var conf_data = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "utxos", revocable_address );
                var info_i_seek = null;
                conf_data.every( utxo => {
                    if ( utxo.txid !== txid_of_tx0 ) return true;
                    info_i_seek = utxo;
                });
                if ( !info_i_seek || !info_i_seek.hasOwnProperty( "status"  ) || !info_i_seek.status.hasOwnProperty( "confirmed" ) ) {
                    chain_client.commander( hedgehog_workshop.network_string.split( "," ), "broadcast", tx_to_broadcast );
                    waiting_for = `Nothing! The transaction corresponding to your latest state was broadcasted and all is well. You should see ${money_coming_to_you.toLocaleString()} sats arrive in your wallet any second.`;
                } else {
                    var num_of_confs = 0;
                    if ( info_i_seek.status.confirmed ) num_of_confs = blockheight - info_i_seek.status.block_height;
                    awaited_blockheight = info_i_seek.status.block_height || blockheight + 5;
                    waiting_for = `You are waiting for confirmations. Hedgehog force closures require two transactions to force close a channel; you've already broadcasted the first one, but the second one is timelocked and cannot be broadcasted til the first one has 5 confirmations. It currently has ${num_of_confs}, so you are waiting for ${5 - num_of_confs} confirmations. When the time is right, your app will broadcast this tx: <br><br>${tx_to_broadcast}`;
                    if ( num_of_confs >= 5 ) chain_client.commander( hedgehog_workshop.network_string.split( "," ), "broadcast", tx_to_broadcast );
                }
            } else {
                if ( channel_data.force_close_data.hasOwnProperty( "full_revocation_tx" ) ) {
                    tx_to_broadcast = channel_data.force_close_data.full_revocation_tx;
                    type_of_tx = "full_revocation_tx";
                    chain_client.commander( hedgehog_workshop.network_string.split( "," ), "broadcast", tx_to_broadcast );
                    money_coming_to_you = Number( tapscript.Tx.decode( tx_to_broadcast ).vout[ 0 ].value );
                    waiting_for = `Nothing! Your counterparty broadcasted very old state so we broadcasted the penalty tx and you should see ${money_coming_to_you.toLocaleString()} sats arrive in your wallet any second.`;
                } else if ( channel_data.force_close_data.hasOwnProperty( "conditional_revocation_tx" ) ) {
                    tx_to_broadcast = channel_data.force_close_data.conditional_revocation_tx;
                    type_of_tx = "conditional_revocation_tx";
                    chain_client.commander( hedgehog_workshop.network_string.split( "," ), "broadcast", tx_to_broadcast );
                    waiting_for = `Nothing! Your counterparty broadcasted the transaction corresponding to his or her most recent state, which does not quite match yours, so you updated the transaction to your latest one. You should see ${money_coming_to_you.toLocaleString()} sats arrive in your wallet any second.`;
                } else {
                    tx_to_broadcast = channel_data.force_close_data.timeout_tx;
                    type_of_tx = "timeout_tx";
                    blockheight = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "blockheight" );
                    var txid_of_tx0 = channel_data.txid_of_tx0;
                    var revocable_address = channel_data.revocable_address;
                    var conf_data = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "utxos", revocable_address );
                    var info_i_seek = null;
                    conf_data.every( utxo => {
                        if ( utxo.txid !== txid_of_tx0 ) return true;
                        info_i_seek = utxo;
                    });
                    if ( !info_i_seek || !info_i_seek.hasOwnProperty( "status"  ) || !info_i_seek.status.hasOwnProperty( "confirmed" ) ) {
                        chain_client.commander( hedgehog_workshop.network_string.split( "," ), "broadcast", tx_to_broadcast );
                        waiting_for = `Nothing! The transaction corresponding to your latest state was broadcasted and all is well. You should see ${money_coming_to_you.toLocaleString()} sats arrive in your wallet any second.`;
                    } else {
                        var num_of_confs = 0;
                        if ( info_i_seek.status.confirmed ) num_of_confs = blockheight - info_i_seek.status.block_height;
                        awaited_blockheight = info_i_seek.status.block_height || blockheight + 5;
                        extra_awaited_blockheight = info_i_seek.status.block_height || blockheight + 10;
                        potential_extra_money = Number( tapscript.Tx.decode( tx_to_broadcast ).vout[ 0 ].value )  + 1_000;
                        waiting_for = `You are waiting for confirmations. Hedgehog force closures require two transactions to force close a channel; your counterparty already broadcasted the first one, but the second one is timelocked and cannot be broadcasted til the first one has 5 confirmations. It currently has ${num_of_confs}, so you are waiting for ${5 - num_of_confs} confirmations. When the time is right, you should see ${money_coming_to_you.toLocaleString()} sats arrive in your wallet. If your counterparty disappears and thus never finalizes the force closure, then after 10 confirmations, you get to broadcast a penalty tx that earns you ${( Number( tapscript.Tx.decode( tx_to_broadcast ).vout[ 0 ].value )  + 1_000 ).toLocaleString()} sats. Your app is waiting ${10 - num_of_confs} more confirmations from now to do that, but it probably won't happen if your counterparty is honest. This is the penalty tx:<br><br>${tx_to_broadcast}`;
                        if ( num_of_confs >= 10 ) chain_client.commander( hedgehog_workshop.network_string.split( "," ), "broadcast", tx_to_broadcast );
                    }
                }
            }

            closing_channels[ chan_id ] = {
                money_coming_to_you,
                tx_to_broadcast,
                type_of_tx,
                waiting_for,
                blockheight,
                awaited_blockheight,
                potential_extra_money,
                extra_awaited_blockheight,
            }
        }

        //Remove any closed channels
        var i; for ( i=0; i<channels_to_remove.length; i++ ) {
            var chan_id = channels_to_remove[ i ];
            if ( hedgehog.state[ chan_id ].i_force_closed ) {
                //you are the person who broadcasted the tx
                var i_am_alice = !!hedgehog.state[ chan_id ].alices_privkey;
                var money_coming_to_you = i_am_alice ? hedgehog.state[ chan_id ].balances[ 0 ] : hedgehog.state[ chan_id ].balances[ 1 ];
                var force_close_txs = hedgehog.state[ chan_id ].latest_force_close_txs;
                var label = hedgehog.state[ chan_id ].label;
                var txid_of_tx0 = tapscript.Tx.util.getTxid( hedgehog.state[ chan_id ].latest_force_close_txs[ 0 ] );
                var spky = tapscript.Tx.decode( hedgehog.state[ chan_id ].latest_force_close_txs[ 0 ] ).vout[ 0 ].scriptPubKey;
                var revocable_address = tapscript.Address.fromScriptPubKey( spky, hedgehog.network );
                hedgehog_workshop.channels_being_closed[ chan_id ] = { label, force_close_txs, i_am_alice, money_coming_to_you, txid_of_tx0, revocable_address };
                delete hedgehog.state[ chan_id ];
            } else {
                //find out if your counterparty broadcasted the right tx
                var closure_txids = Object.keys( hedgehog.state[ chan_id ].txids_to_watch_for );
                var force_close_data = null;
                var j; for ( j=0; j<closure_txids.length; j++ ) {
                    var tx_exists = await chain_client.commander( hedgehog_workshop.network_string.split( "," ), "rawtx", closure_txids[ i ] );
                    if ( !hedgehog.isValidHex( tx_exists ) ) continue;
                    force_close_data = { ...hedgehog.state[ chan_id ].txids_to_watch_for[ closure_txids[ i ] ], txid: closure_txids[ i ]} ;
                    break;
                }
                if ( force_close_data ) {
                    var i_am_alice = !!hedgehog.state[ chan_id ].alices_privkey;
                    var money_coming_to_you = i_am_alice ? hedgehog.state[ chan_id ].balances[ 0 ] : hedgehog.state[ chan_id ].balances[ 1 ];
                    var label = hedgehog.state[ chan_id ].label;
                    var multisig = hedgehog.state[ chan_id ].multisig;
                    var txid_of_tx0 = force_close_data.txid;
                    var spky = tapscript.Tx.decode( force_close_data.tx0 ).vout[ 0 ].scriptPubKey;
                    var revocable_address = tapscript.Address.fromScriptPubKey( spky, hedgehog.network );
                    hedgehog_workshop.channels_being_closed[ chan_id ] = { label, force_close_data, i_am_alice, money_coming_to_you, txid_of_tx0, revocable_address };
                    delete hedgehog.state[ chan_id ];
                }
            }
        }

        return { channels_to_keep, closing_channels }
    },
    getChannelOpeningData: () => {
        var privkey = hedgehog.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() );
        var pubkey = nobleSecp256k1.getPublicKey( privkey, true ).substring( 2 );
        var preimage = hedgehog.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ).substring( 0, 32 );
        var hash = hedgehog.rmd160( hedgehog.hexToBytes( preimage ) );
        hedgehog.keypairs[ pubkey ] = {privkey, preimage};
        var address = hedgehog_workshop.btc_address;
        return [ pubkey, hash, address ];
    },
}
