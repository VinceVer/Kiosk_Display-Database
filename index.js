process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'

/* Module dependencies. */
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs').promises;
const Imap = require('imap');
const sqlite3 = require('sqlite3');
const util = require('util');
const yaml = require('js-yaml');

const {htmlToText} = require('html-to-text');
const {simpleParser} = require('mailparser');

fsp.access('./bin/main-database.db', fs.constants.F_OK, error => {
    if (error) {
        fs.writeFileSync('./bin/main-database.db', "");
    }
})
const Database = new sqlite3.Database('./bin/main-database.db');
Database.run('CREATE TABLE IF NOT EXISTS devicetimeline (time INTEGER, type TEXT, device_name TEXT, kiosk_name TEXT, conn_status INTEGER, comm_status INTEGER, coupons_printed INTEGER, execution_status TEXT, fault_status INTEGER, paper_jams INTEGER, mediabin1_status INTEGER, last_seen TEXT, last_update TEXT, service_connection INTEGER, tags_printed INTEGER, target_status TEXT, status_message TEXT, from_urgency_level INTEGER, to_urgency_level INTEGER)');
Database.run('CREATE TABLE IF NOT EXISTS apptimeline (time INTEGER, type TEXT, kiosk_name TEXT, app_status INTEGER, last_seen TEXT, status_message TEXT, from_urgency_level INTEGER, to_urgency_level INTEGER)');
Database.run('CREATE TABLE IF NOT EXISTS kiosktimeline (time INTEGER, kiosk_name TEXT, from_urgency_level INTEGER, to_urgency_level INTEGER)');

const config = JSON.parse(fs.readFileSync('../.website/storage/config.json'));
const status_database = JSON.parse(fs.readFileSync('./bin/status_database.json'));
//const old_database = status_database;

const status_messages = config.status_messages;
const table_naming = config.table_naming;
const urgency_conditions = config.urgency_conditions;

const status_408 = status_messages.app.codes[408];
const status_2 = status_messages.conn.codes[2];
const status_0 = status_messages.conn.codes[0];

/* Imap Config. */
const yamlData = fs.readFileSync('./bin/.imap-config.yaml', 'utf8');
const imapConfig = yaml.load(yamlData);
/* ------------ */

const urgency_icons = {
    _1: "🟢",
    null: "❔",
    0: "🔵",
    1: "🟡",
    2: "🟣",
    3: "🟠",
    4: "🔴",
    5: "⚠️",
    12: "🟣",
    42: "🔴"
}

const urgency_notes = {
    12: "+ 🟡 Paper low.",
    42: "+ 🟣 App problem."
}

let HandlerOpen = true;



if (!fs.existsSync(__dirname+"/tmp")) {
    fs.mkdirSync(__dirname+"/tmp", { recursive: true });
}



/* Read email form inbox. */
const getEmails = () => {
    try {
        const imap = new Imap(imapConfig);
  
        // Open and read the inbox:
        imap.once('ready', () => {
            console.log("Connected");
            imap.openBox('INBOX', false, () => {
                const misc = JSON.parse(fs.readFileSync('../.website/storage/misc.json'));
                misc.last_check = "Fetching...";
                fs.writeFileSync('../.website/storage/misc.json', JSON.stringify(misc, null, "\t"));

                imap.search(['UNSEEN', ['SINCE', new Date()]], (err, results) => {
                    if (err) {
                        console.log('Error searching for emails:', err);
                        imap.end();
                        return;
                    }
                
                    if (results.length === 0) {
                        console.log('No unseen emails found.');
                        imap.end();
                        return;
                    }

                    const f = imap.fetch(results, {bodies: ''});

                    imap.addFlags(results, ['\\Deleted'], function(err) {
                        if (!err) {
                            console.log("Marked as Deleted");
                    
                            // Now expunge to permanently delete those emails
                            imap.expunge(function(errExpunge) {
                                if (!errExpunge) {
                                    console.log("Deleted Emails Permanently");
                                } else {
                                    console.log(JSON.stringify(errExpunge, null, 2));
                                }
                            });
                    
                        } else {
                            console.log(JSON.stringify(err, null, 2));
                        }
                    });

                    f.on('message', (msg, seqno) => {
                        console.log("Message #%d", seqno)

                        msg.on('body', stream => {
                            simpleParser(stream, async (err, parsed) => {
                                //console.log(parsed.subject);

                                processEmail(parsed)
                            });
                        });

                        /*
                        msg.once('attributes', attrs => {
                            imap.setFlags(attrs.uid, ['\\Seen'], (err) => {
                                if (err) {
                                    console.log(err);
                                } else {
                                    console.log("Marked as read!");
                                }
                            });
                        });
                        */
                    });
            
                    f.once('error', ex => {
                        return Promise.reject(ex);
                    });
            
                    f.once('end', () => {
                        imap.end();
                    });
                });
            });
        });
    
        imap.once('error', err => {
            console.log(err);
        });
    
        imap.once('close', () => {
            console.log('Connection ended');

            updateData();
        });
    
        imap.connect();
    } catch (ex) {
        console.log('an error occurred');
    }
};
/* ---------------------- */

/* Process emails. */
const processEmail = async (parsed) => {
    const emailData = htmlToText(parsed.html, {
        formatters: {
            // Create a formatter.
            'lineBreak': function (elem, walk, builder, formatOptions) {
                builder.openBlock({ leadingLineBreaks: formatOptions.leadingLineBreaks || 1 });
                builder.addInline(formatOptions.breakText || "")
                walk(elem.children, builder);
                builder.closeBlock({ trailingLineBreaks: formatOptions.trailingLineBreaks || 1 });
            },
            'lineBreak2': function (elem, walk, builder, formatOptions) {
                builder.openBlock({ leadingLineBreaks: formatOptions.leadingLineBreaks || 1 });
                walk(elem.children, builder);
                builder.addInline(formatOptions.breakText || "")
                builder.closeBlock({ trailingLineBreaks: formatOptions.trailingLineBreaks || 1 });
            }
        },
        selectors: [
            //{ selector: 'table', format: 'table', options: {leadingLineBreaks:2}}/*\
            { selector: 'table', format: 'lineBreak2', options: {breakText: "/"}},
            { selector: 'tr', format: 'lineBreak', options: {breakText: "\n|\n"}},
            { selector: 'td', format: 'lineBreak', options: {breakText: "/"}},
            { selector: 'th', format: 'lineBreak'},
            //{ selector: 'li', format: 'lineBreak', options: {breakText: "/*/"}}
        ]
    });

    if (parsed.subject.toLowerCase().includes('kiosk')) {
        await analyseData_DEVICES_v2(emailData);
    }

    if (parsed.subject.toLowerCase().includes('app')) {
        await analyseData_APPS(emailData);
    }
};

// const deleteEmail = async (uid) => {
//     const addFlags = util.promisify(imap.addFlags.bind(imap));
//     await addFlags(uid, ['\\Deleted']);
//     const expunge = util.promisify(imap.expunge.bind(imap));
//     await expunge();
//     console.log('Email deleted!');
// };

const updateData = async () => {
    console.log('Done fetching all messages!');

    await verifyDatabase();

    //fs.writeFileSync('./bin/status_database.json', JSON.stringify(status_database, null, '\t'));
    try {
        await fsp.writeFile('./tmp/status_database.json', JSON.stringify(status_database, null, '\t'));
        await fsp.rename('./tmp/status_database.json', './bin/status_database.json');
        console.log('Atomic write completed successfully.');
    } catch (error) {
        console.error('Error during atomic write:', error);
    }

    const misc = JSON.parse(fs.readFileSync('../.website/storage/misc.json'));
    misc.last_check = new Date();
    misc.score = calculateScore();

    misc.groups = {};
    for (let groupIndex in config.groups) {
        const groupName = config.groups[groupIndex].name,
              groupTotals = getTotals(groupName);

        misc.groups[groupName] = {
            number_of_locations: config.groups[groupIndex].locations.length,
            number_of_kiosks: groupTotals.kiosks,
            number_of_devices: groupTotals.devices,
            number_of_applications: groupTotals.applications,
            health_score: calculateScore(groupName)
        }
    }

    fs.writeFileSync('../.website/storage/misc.json', JSON.stringify(misc, null, "\t"));
    console.log(`Health Score: ${misc.score}%`);

    try {
        const hubData = fs.readFileSync('../.website/storage/hub-connection.txt', 'utf8');
        const hubIp = hubData.split(">")[0],
              location = hubData.split(">")[1];


        if (hubIp) {
            axios.put(hubIp+'/sync/'+location, {data: misc})
                .then(response => {
                    console.log("Response:", response.code, response.message);
                })
                .catch(error => {
                    console.error("Error connecting to the hub.");
                });
        } else {
            console.log("Cannot find an IP to the hub. This can be setup by entering the ip of this page in 'connections.yaml' in the hub.");
        }
    } catch (error) {
        console.log("Error connecting to the hub.");
    }

    setTimeout(function() {
        Database.close((err) => {
            if (err) {
                console.error('Error closing the database:', err.message);
            } else {
                console.log('Database closed.');
            }
        });
    }, 500);
}



/* Functions. */
const calculateScore = (groupName) => {
    let counter = 0, maxCounter = 0;

    for (let kioskName in status_database) {
        if (groupName === undefined || groupName === status_database[kioskName].group) {
            maxCounter += 1;

            switch(status_database[kioskName].urgency_level) {
                case 2:
                    counter += calculateScore_App(status_database[kioskName].applications);
                    break;
                case 1:
                    counter += 0.75;
                    break;
                case 0:
                case null:
                    maxCounter--;
                    break;
                case -1:
                    counter++;
                    break;
            }
        }
    }

    console.log(counter, maxCounter)
    const result = Math.floor(counter / maxCounter * 100);

    return result;
}

const calculateScore_App = (appList) => {
    let counter = 0;

    for (let appName in appList) {
        switch(appList[appName].urgency_level) {
            case 1:
                counter += 0.75;
            case -1:
                counter++;
        }
    }

    return counter / Object.keys(appList).length;
}

const checkAccept = (data, indices, type) => {
    if (eval(config.misc_conditions["database_filter$" + type], data)) {return true};
    return false;
}

const createDateTimestamp = (date) => {
    if (!date) {return undefined}
    let segments, datum, time;

    segments = date.split(" ");
    datum = segments[0].split(".");
    time = segments[segments.length-1];

    return `${datum[2]}-${datum[1]}-${datum[0]}T${time}`;
}

const getKioskUrgencyData = (kioskObject) => {
    const currentTime = kioskObject.last_seen ? new Date(kioskObject.last_seen) : new Date();
    const unixTimestamp = Math.floor(currentTime.getTime() / 1000);

    let appUrgencyLevel = -1, deviceUrgencyLevel = -1, objectUrgencyLevel;
    let appCounter = 0, deviceCounter = 0;
    let outputNote;

    for (let deviceIndex in kioskObject.devices) {
        objectUrgencyLevel = kioskObject.devices[deviceIndex].urgency_level
        if (objectUrgencyLevel > deviceUrgencyLevel) {
            deviceUrgencyLevel = objectUrgencyLevel
            deviceCounter = 1;
            outputNote = `> ${deviceIndex}.`;
        } else if (objectUrgencyLevel !== -1) {
            deviceCounter++;
            outputNote = `${deviceCounter} problems.`;
        }
    }
    for (let appIndex in kioskObject.applications) {
        objectUrgencyLevel = kioskObject.applications[appIndex].urgency_level
        if (objectUrgencyLevel > appUrgencyLevel) {
            appUrgencyLevel = objectUrgencyLevel
            appCounter = 1;
            outputNote = "";
        } else if (objectUrgencyLevel !== -1) {
            appCounter++;
            outputNote = `${appCounter} problems.`;
        }
    }

    if (appUrgencyLevel > -1 && deviceUrgencyLevel > -1 && urgency_icons[`${deviceUrgencyLevel}${appUrgencyLevel}`]) {
        const outputLevel = `${deviceUrgencyLevel}${appUrgencyLevel}`;

        if (Number(outputLevel) !== kioskObject.urgency_level && kioskObject.last_seen) {updateKioskTimeline(unixTimestamp, kioskObject.id, kioskObject.urgency_level, outputLevel);}

        return {
            urgency_level: Number(outputLevel),
            icon: urgency_icons[outputLevel],
            note: urgency_notes[outputLevel] || ""
        };
    } else {
        const outputLevel = deviceUrgencyLevel !== -1 ? deviceUrgencyLevel : appUrgencyLevel;

        if (outputLevel !== kioskObject.urgency_level && kioskObject.last_seen) {updateKioskTimeline(unixTimestamp, kioskObject.id, kioskObject.urgency_level, outputLevel);}

        return {
            urgency_level: outputLevel,
            icon: urgency_icons[String(outputLevel).replace("-","_")],
            note: outputNote
        };
    }
}

const getOldestReport = (kioskObject) => {
    const currentDate = new Date();
    let timeDiff = 0, oldestReport;

    try {
        for (let deviceName in kioskObject.devices) {
            if (kioskObject.devices[deviceName].urgency_level > -1 && currentDate - new Date(kioskObject.devices[deviceName].last_seen) > timeDiff) {
                oldestReport = kioskObject.devices[deviceName].last_seen;
                timeDiff = currentDate - new Date(kioskObject.devices[deviceName].last_seen);
            }
        }

        for (let applicationName in kioskObject.applications) {
            if (kioskObject.applications[applicationName].urgency_level > -1 && currentDate - new Date(kioskObject.applications[applicationName].last_seen) > timeDiff) {
                oldestReport = kioskObject.applications[applicationName].last_seen;
                timeDiff = currentDate - new Date(kioskObject.applications[applicationName].last_seen);
            }
        }

        return oldestReport;
    } catch (error) {return undefined;}
}

const getStatusData = (data, urgencyLevel, indices) => {
    const connStatusCodes = status_messages.conn.codes;
    if (urgencyLevel === -1) {return {icon: connStatusCodes[2].icon, message: (connStatusCodes[2].messages[Math.floor(Math.random() * connStatusCodes[2].messages.length)] || connStatusCodes[2].default)};}
    if (urgencyLevel === 0) {return {icon: connStatusCodes[0].icon, message: (connStatusCodes[0].messages[Math.floor(Math.random() * connStatusCodes[0].messages.length)] || connStatusCodes[0].default)};}
    
    let dataKey, statusObject;
    for (let statusType in status_messages) {
        dataKey = indices[statusType+"_status"] || indices[statusType+"_connection"];

        if (!isNaN(data[dataKey]) && data[dataKey] !== 2 && data[dataKey] !== 0) { // SUBJECT TO CHANGE
            statusObject = status_messages[statusType].codes[data[dataKey]];

            if (statusObject.messages.length === 0) {
                return {icon: statusObject.icon, message: statusObject.default};
            }
            return {icon: statusObject.icon, message: statusObject.messages[Math.floor(Math.random() * statusObject.messages.length)]};
        }
    }

    return {icon: '❔', message: "Undefined Message. Click to fix."};
}

const getTotals = (groupName) => {
    const totals = {
        kiosks: 0,
        devices: {
            total: 0
        },
        applications: {
            total: 0
        }
    }

    for (let kioskName in status_database) {
        if (groupName === undefined || groupName === status_database[kioskName].group) {
            totals.kiosks++;
            
            for (let deviceName in status_database[kioskName].devices) {
                const deviceType = deviceName.split(/[0-9.]/)[0];
                if (!totals.devices[deviceType]) totals.devices[deviceType] = 0;
                totals.devices[deviceType] += 1;
            }
            totals.devices.total += Object.keys(status_database[kioskName].devices).length;

            for (let appName in status_database[kioskName].applications) {
                if (!totals.applications[appName]) totals.applications[appName] = 0;
                totals.applications[appName] += 1;
            }
            totals.applications.total += Object.keys(status_database[kioskName].applications).length;
        }
    }

    return totals;
}

const getUrgencyLevel = (data, deviceType, indices) => {
    let conditionIndex, level, levelObject, result;

    result = () => {
        for (level in urgency_conditions) {
            levelObject = urgency_conditions[level];
            for (conditionIndex in levelObject.inputs) {
                if (levelObject.inputs[conditionIndex].applies_to.includes("*") || levelObject.inputs[conditionIndex].applies_to.includes(deviceType)) {
                    if (eval(levelObject.inputs[conditionIndex].condition, data)) {return Number(level)}
                }
            }
        }
        return -1;
    }

    return result();
}

const findLocation = (name) => {
    for (let group of config.groups) {
        for (let location of group.locations) {
            for (let selector of location.selectors) {
                if (name.includes(selector.replaceAll("_",""))) {
                    return {group: group.name, location: location.name};
                }
            }
        }
    }

    return undefined;
}

const handleError = (logName, errorData) => {
    HandlerOpen = false;
    let error = "";

    for (let property in errorData) {
        error += `${property}:\n${errorData[property]}\n\n`;
    }

    fs.writeFile(`./bin/logs/${logName}_${Math.ceil(Math.random()*100000)}.txt`, error, (err) => {
        if (!err) {console.log("An error has been logged")};
    });
}

const newItem = (kioskName, group, itemName) => {
    status_database[kioskName][group][itemName] = {}

    if (group === "applications" && !config.applications[itemName]) {
        config.applications[itemName] = "undefined";
        fs.writeFileSync('../.website/storage/config.json', JSON.stringify(config, null, '\t'));
    }

    return status_database[kioskName][group][itemName];
}

const newKiosk = (kioskName) => {
    const locationData = findLocation(kioskName) || {};
    status_database[kioskName] = {
        id: kioskName,
        group: locationData.group || ".undefined",
        location: locationData.location || ".undefined",
        urgency_level: -1,
        urgency_icon: "",
        note: "",
        devices: {},
        applications: {}
    }

    return status_database[kioskName];
}

const updateKioskTimeline = (time, kioskName, old_urgency, new_urgency) => {
    const insertData = [
        time,
        kioskName,
        old_urgency,
        new_urgency
    ]
    Database.get('SELECT * FROM kiosktimeline WHERE time = ? AND kiosk_name = ?', [time, kioskName], (err, existingRow) => {
        if (existingRow) {
            insertData.push(time, kioskName);
            Database.run('UPDATE kiosktimeline SET time = ?, kiosk_name = ?, from_urgency_level = ?, to_urgency_level = ? WHERE time = ? AND kiosk_name = ?', insertData, (err) => {
                if (err) {
                    handleError("Database UPDATE", {Error_inserting_new_row: err.message})
                }
            });
        } else {
            Database.run('INSERT INTO kiosktimeline (time, kiosk_name, from_urgency_level, to_urgency_level) VALUES (?, ?, ?, ?)', insertData, function(err) {
                if (err) {
                    handleError("Database INSERT", {Error_inserting_new_row: err.message})
                }
            });
        }
    });
}

const updateTimeline = (deviceObject, old_urgency) => {
    const currentTime = new Date(deviceObject.last_seen);
    const unixTimestamp = Math.floor(currentTime.getTime() / 1000);

    const insertData = [
        unixTimestamp,
        deviceObject.device_name.split(/[0-9.]/)[0],
        deviceObject.device_name,
        deviceObject.kiosk_name,

        deviceObject.conn_status,
        deviceObject.comm_status,
        deviceObject.coupons_printed,
        deviceObject.execution_status,
        deviceObject.fault_status,
        deviceObject.paper_jams,
        deviceObject.mediabin1_status,
        deviceObject.last_seen,
        deviceObject.last_update,
        deviceObject.service_connection,
        deviceObject.target_status,
        deviceObject.status_message,
        old_urgency,
        deviceObject.urgency_level,
        deviceObject.tags_printed
    ]

    Database.get('SELECT * FROM devicetimeline WHERE time = ? AND device_name = ?', [unixTimestamp, deviceObject.device_name], (err, existingRow) => {
        if (existingRow) {
            insertData.push(unixTimestamp, deviceObject.device_name);
            Database.run('UPDATE devicetimeline SET time = ?, type = ?, device_name = ?, kiosk_name = ?, conn_status = ?, comm_status = ?, coupons_printed = ?, execution_status = ?, fault_status = ?, paper_jams = ?, mediabin1_status = ?, last_seen = ?, last_update = ?, service_connection = ?, target_status = ?, status_message = ?, from_urgency_level = ?, to_urgency_level = ?, tags_printed = ? WHERE time = ? AND device_name = ?', insertData, (err) => {
                if (err) {
                    handleError("Database UPDATE", {Error_inserting_new_row: err.message})
                }
            });
        } else {
            Database.run('INSERT INTO devicetimeline (time, type, device_name, kiosk_name, conn_status, comm_status, coupons_printed, execution_status, fault_status, paper_jams, mediabin1_status, last_seen, last_update, service_connection, target_status, status_message, from_urgency_level, to_urgency_level, tags_printed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', insertData, function(err) {
                if (err) {
                    handleError("Database INSERT", {Error_inserting_new_row: err.message})
                }
            });
        }
    });
}

const verifyDatabase = () => {
    return new Promise(async (resolve, reject) => {
        await verifyDatabase_QUEUE();

        /* Time correction */
        let kiosk;

        for (let kioskName in status_database) {
            kiosk = status_database[kioskName];

            for (let deviceName in kiosk.devices) {
                if (new Date() - new Date(kiosk.devices[deviceName].last_seen) >= 86400000) {
                    const deviceType = deviceName.split(/[0-9.]/)[0];
                    let urgencyLevel = null;

                    for (let deviceName2 in kiosk.devices) {
                        if (deviceName2.startsWith(deviceType) && deviceName2 !== deviceName && new Date() - new Date(kiosk.devices[deviceName2].last_seen) < 86400000) {
                            urgencyLevel = -1;
                            break;
                        }
                    }

                    with (kiosk.devices[deviceName]) {
                        urgency_level = urgencyLevel;
                        status_indicator = status_0.icon;
                        status_message = status_0.messages[Math.floor(Math.random() * status_0.messages.length)];
                    }  
                }
            }

            for (let appName in kiosk.applications) {
                if (new Date() - new Date(kiosk.applications[appName].last_seen) >= 9000000 && !config.ignored_apps.includes(appName)) {
                    with (kiosk.applications[appName]) {
                        urgency_level = status_408.urgency_level;
                        status_indicator = status_408.icon;
                        status_message = status_408.messages[Math.floor(Math.random() * status_408.messages.length)];
                    }
                }
            }

            const urgency_data = getKioskUrgencyData(kiosk);
            kiosk.urgency_icon = urgency_data.icon;
            kiosk.urgency_level = urgency_data.urgency_level;
            kiosk.note = urgency_data.note;
        }
        /* --------------- */
        resolve(true);
    });
}

const verifyDatabase_QUEUE = () => {
    console.log("Going through the queue")
    return new Promise((resolve, reject) => {
        const queue = JSON.parse(fs.readFileSync('../.website/storage/queue.json'));
        for (let targetName in queue) {
            let success = false;
            const kiosk = status_database[targetName.split(".")[targetName.split(".").length-1]];
            console.log("KIOSK", kiosk.id)
            const kioskName = kiosk.id;

            // Test for kioskName:
            if (kioskName === targetName) {
                switch(queue[targetName]) {
                    case "ONLINE":
                        for (let deviceName in kiosk.devices) {
                            if (kiosk.devices[deviceName].urgency_level !== -1) {
                                const oldUrgency = kiosk.devices[deviceName].urgency_level;
                                with (kiosk.devices[deviceName]) {
                                    last_seen = (new Date()).toISOString().slice(0, 19);
                                    last_update = (new Date()).toISOString().slice(0, 19);
                                    urgency_level = -1;
                                    status_indicator = status_2.icon;
                                    status_message = status_2.messages[Math.floor(Math.random() * status_2.messages.length)]+" [Manually Set]";
                                }
                                updateTimeline(kiosk.devices[deviceName], oldUrgency);
                            }
                        }
                        // const urgency_data = getKioskUrgencyData(kiosk)
                        // kiosk.urgency_level = urgency_data.urgency_level;
                        // kiosk.icon = urgency_data.icon;
                        kiosk.note = "";
                        break;
                    case "DELETE":
                        delete status_database[kioskName];
                        break;
                }
                continue;
            }
                
            // Test for deviceName:
            for (let deviceName in kiosk.devices) {
                if (deviceName+"."+kioskName === targetName) {
                    switch(queue[targetName]) {
                        case "ONLINE":
                            const oldUrgency = kiosk.devices[deviceName].urgency_level;
                            with (kiosk.devices[deviceName]) {
                                last_seen = (new Date()).toISOString().slice(0, 19);
                                last_update = (new Date()).toISOString().slice(0, 19);
                                urgency_level = -1;
                                status_indicator = status_2.icon;
                                status_message = status_2.messages[Math.floor(Math.random() * status_2.messages.length)]+" [Manually Set]";
                            }
                            updateTimeline(kiosk.devices[deviceName], oldUrgency);
                            break;
                        case "IGNORE":
                            with (kiosk.devices[deviceName]) {
                                urgency_level = -1;
                                status_message = "[Ignored Status]";
                            }
                            break;
                        case "DELETE":
                            delete kiosk.devices[deviceName];
                            break;
                    }
                    // const urgency_data = getKioskUrgencyData(kiosk)
                    // kiosk.urgency_level = urgency_data.urgency_level;
                    // kiosk.icon = urgency_data.icon;
                    success = true;
                    break;
                }
            }
            if (success) continue;

            // Test for appName:
            for (let appName in kiosk.applications) {
                if (appName+"."+kioskName === targetName) {
                    switch(queue[targetName]) {
                        case "ONLINE":
                            with (kiosk.applications[appName]) {
                                app_status = 15;
                                last_seen = (new Date()).toISOString().slice(0, 19);
                                last_update = (new Date()).toISOString().slice(0, 19);
                                urgency_level = -1;
                                status_indicator = status_2.icon;
                                status_message = status_2.messages[Math.floor(Math.random() * status_2.messages.length)]+" [Manually Set]";
                            }
                            break;
                        case "IGNORE":
                            with (kiosk.applications[appName]) {
                                urgency_level = -1;
                                status_message = "[Ignored Status]";
                            }
                        case "DELETE":
                            delete kiosk.applications[appName];
                            break;
                    }
                    // const urgency_data = getKioskUrgencyData(kiosk)
                    // kiosk.urgency_level = urgency_data.urgency_level;
                    // kiosk.icon = urgency_data.icon;
                    break;
                }
            }
        }
        fs.writeFileSync('../.website/storage/queue.json', JSON.stringify({}, null, "\t"));
        resolve(true);
    });
};
/* ---------- */



/* Data Analyser. */
let dataRow, deviceName, deviceObject, kioskName, kioskObject, kioskUrgency, newUrgency, oldUrgency, statusData;
const analyseData_DEVICES_v2 = async (data) => {
    const emailInfo = data.split("\n\n\n|\n")[0],
          dataTypes = data.split("\n\n\n|\n")[1].split("\n|\n")[0].split("\n"),
          dataArray = data.split("\n\n\n|\n")[1].split("\n|\n").slice(1),
          dataGroups = {},
          foundIndices = [];

    let subGroupName;
    for (let typeIndex in dataTypes) {
        if (dataTypes[typeIndex].includes("/")) {
            subGroupName = dataTypes[typeIndex].replaceAll(" ","_").split("/")[1].split("_")[0];
            if (!dataGroups[subGroupName]) {dataGroups[subGroupName] = {}};
            dataGroups[subGroupName][dataTypes[typeIndex].toLowerCase().replaceAll(" ","_").split("/")[1].substring(dataTypes[typeIndex].replaceAll(" ","_").split("/")[1].indexOf('_')+1)] = Number(typeIndex);
            foundIndices.push(Number(typeIndex));
        }
    }
    //console.log(dataGroups);
    /* -------------------------- */



    /* Loop through the data rows. */
    for (let subGroupName in dataGroups) {
        if (subGroupName.length === 3) {
            const indices = dataGroups[subGroupName];
            for (let key in table_naming) {
                if (!indices[key] && !foundIndices.includes(key)) {indices[key] = dataTypes.findIndex(item => item.toLowerCase().replaceAll(" ","_").includes(table_naming[key].toLowerCase().replaceAll(" ","_")));}
            }

            let indexFound = false;
            for (let typeIndex in dataTypes) {
                if (!dataTypes[typeIndex].includes("/") && !foundIndices.includes(Number(typeIndex))) {
                    indexFound = false;
                    for (let key in indices) {
                        if (indices[key] === Number(typeIndex)) {
                            indexFound = true;
                            break;
                        }
                    }
                    if (!indexFound) {indices[dataTypes[typeIndex].toLowerCase().replaceAll(" ","_")] = Number(typeIndex)}
                }
            }

            for (let dataRowIndex in dataArray) {
                dataRow = dataArray[dataRowIndex].replaceAll("\n","").split("/").slice(1);
                dataRow = dataRow.map(item => item = isNaN(Number(item)) ? item : Number(item));

                if (dataRow[indices.device_name] && dataRow[indices.device_name].includes(".") && checkAccept(dataRow, indices, "ALL")) {
                    try {
                        // Names:
                        kioskName = dataRow[indices.kiosk_name];
                        deviceName = dataRow[indices.device_name].replace("."+kioskName,"");

                        // Objects in database:
                        kioskObject = status_database[kioskName] || newKiosk(kioskName);
                        deviceObject = kioskObject.devices[deviceName] || newItem(kioskName, "devices", deviceName);
                        oldUrgency = deviceObject.urgency_level;

                        const lastSeenTimestamp = createDateTimestamp(dataRow[indices.last_seen]) || createDateTimestamp(dataRow[indices.last_execution]);
                        if (!deviceObject.last_seen || deviceObject.last_seen < lastSeenTimestamp || deviceObject.last_seen.includes("undefined")) {
                            // Set all properties:
                            for (let key in indices) {
                                deviceObject[key] = isNaN(dataRow[indices[key]]) ? dataRow[indices[key]] : Number(dataRow[indices[key]]);
                            }

                            // Set special properties:
                            if (!kioskObject.last_seen || kioskObject.last_seen < lastSeenTimestamp || kioskObject.last_seen.includes("undefined")) {
                                kioskObject.last_seen = lastSeenTimestamp;
                            }
                            deviceObject.last_seen = lastSeenTimestamp;

                            newUrgency = getUrgencyLevel(dataRow, deviceName.split(/[0-9.]/)[0], indices);
                            if (newUrgency !== deviceObject.urgency_level) {
                                deviceObject.last_update = deviceObject.last_seen;
                                kioskObject.oldest_report = getOldestReport(kioskObject);
                            };
                            deviceObject.urgency_level = config.ignored_apps.includes(deviceName.split(/[0-9.]/)) ? -1 : getUrgencyLevel(dataRow, deviceName.split(/[0-9.]/)[0], indices);

                            statusData = getStatusData(dataRow, deviceObject.urgency_level, indices);
                            deviceObject.status_message = config.ignored_apps.includes(deviceName.split(/[0-9.]/)) ? "[Status Ignored]" : statusData.message;
                            deviceObject.status_indicator = statusData.icon;

                            // kioskUrgency = getKioskUrgencyData(kioskObject);
                            
                            const locationData = findLocation(kioskName);
                            kioskObject.group = locationData.group || ".undefined";
                            kioskObject.location = locationData.location || ".undefined";

                            // kioskObject.urgency_level = kioskUrgency.urgency_level;
                            // kioskObject.urgency_icon = kioskUrgency.icon;
                            // kioskObject.note = kioskUrgency.note;

                            updateTimeline(deviceObject, oldUrgency);
                        }
                    } catch (error) {
                        handleError(deviceName, {Time: new Date(), Error: error, Table_Row: dataRow, Email_Data: data})
                    }
                }
            }
        }
    }
    /* --------------------------- */
}

let appCode, appIndex, appInfo, appObject, appStatus, lastSeen, statusObject;
const analyseData_APPS = async (data) => {
    const emailInfo = data.split("\n\n\n|\n")[0],
          dataTypes = data.split("\n\n\n|\n")[1].split("\n|\n")[0].split("\n"),
          dataArray = data.split("\n\n\n|\n")[1].split("\n|\n").slice(1),
          indices = {};
    let appList;

    //console.log(emailInfo.split("Time:\n")[1]);

    /* Loop through declarations. */
    for (let key in table_naming) {
        indices[key] = dataTypes.findIndex(item => item.toLowerCase().replaceAll(" ","_").includes(table_naming[key].toLowerCase().replaceAll(" ","_")));
    }
    /* -------------------------- */



    /* Loop through the data rows. */
    for (let dataRowIndex in dataArray) {    
        dataRow = dataArray[dataRowIndex].replaceAll("\n","").split("/").slice(1);
        dataRow = dataRow.map(item => item = isNaN(Number(item)) ? item : Number(item));

        if (checkAccept(dataRow, indices, "APP")) {
            try {
                // Kiosk:
                kioskName = dataRow[indices.kiosk_name];
                kioskObject = status_database[kioskName] || newKiosk(kioskName);

                lastSeen = createDateTimestamp(dataRow[indices.last_seen]) || createDateTimestamp(dataRow[indices.last_execution]);

                appList = dataRow[indices.running_app_list].concat(dataRow[indices.unavailable_app_list]).replaceAll(" ","").split("*").slice(1);

                for (appIndex in appList) {
                    appInfo = appList[appIndex].split("=");
                    if (appInfo.length === 2) {
                        [appCode, appStatus] = appInfo;

                        appObject = kioskObject.applications[appCode] || newItem(kioskName, "applications", appCode);
                        statusObject = config.status_messages.app.codes[appStatus];

                        if (!appObject.last_seen || appObject.last_seen < lastSeen || appObject.last_seen.includes("undefined")) {
                            // Set special properties:
                            appObject.display_name = config.applications[appCode] === "undefined" ? undefined : config.applications[appCode];
                            appObject.app_status = Number(appStatus);

                            if (newUrgency !== appObject.urgency_level) {
                                appObject.last_update = appObject.last_seen;
                                kioskObject.oldest_report = getOldestReport(kioskObject);
                            };
                            appObject.urgency_level = config.ignored_apps.includes(appCode) ? -1 : statusObject.urgency_level;

                            appObject.status_indicator = statusObject.icon;
                            appObject.status_message = config.ignored_apps.includes(appCode) ? "[Status Ignored]" : (statusObject.messages[Math.floor(Math.random() * statusObject.messages.length)] || statusObject.default);
                            appObject.last_seen = lastSeen;
                        }
                    }
                }

                // Set special properties:
                // kioskUrgency = getKioskUrgencyData(kioskObject);

                const locationData = findLocation(kioskName)
                kioskObject.group = locationData.group || ".undefined";
                kioskObject.location = locationData.location || ".undefined";

                // kioskObject.urgency_level = kioskUrgency.urgency_level;
                // kioskObject.urgency_icon = kioskUrgency.icon;
                // kioskObject.note = kioskUrgency.note;
                kioskObject.oldest_report = getOldestReport(kioskObject);
            } catch (error) {
                handleError(deviceName, {Time: new Date(), Error: error, Table_Row: dataRow, Email_Data: data})
            }
        }
    }
    /* --------------------------- */
}
/* --------------- */



/* START. */
getEmails()
/* ------ */