process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'

/* Module dependencies. */
const fs = require('fs');
const Imap = require('imap');
const sqlite3 = require('sqlite3');
const util = require('util');
const yaml = require('js-yaml');

const {htmlToText} = require('html-to-text');
const {simpleParser} = require('mailparser');

const Database = new sqlite3.Database('./bin/main-database.db');
Database.run('CREATE TABLE IF NOT EXISTS devicetimeline (time TEXT, type TEXT, device_name TEXT, kiosk_name TEXT, conn_status INTEGER, comm_status INTEGER, coupons_printed INTEGER, execution_status TEXT, fault_status INTEGER, paper_jams INTEGER, mediabin1_status INTEGER, last_seen TEXT, last_update TEXT, service_connection INTEGER, target_status TEXT, status_message TEXT, urgency_level INTEGER)');
Database.run('CREATE TABLE IF NOT EXISTS apptimeline (time TEXT, type TEXT, kiosk_name TEXT, app_status INTEGER, last_seen TEXT, status_message TEXT, urgency_level INTEGER)');

const config = JSON.parse(fs.readFileSync('../.website/storage/config.json'));
const misc = JSON.parse(fs.readFileSync('../.website/storage/misc.json'));
const status_database = JSON.parse(fs.readFileSync('./bin/status_database.json'));

const status_messages = config.status_messages;
const table_naming = config.table_naming;
const urgency_conditions = config.urgency_conditions;

/* Imap Config. */
const yamlData = fs.readFileSync('./bin/.imap-config.yaml', 'utf8');
const imapConfig = yaml.load(yamlData);
/* ------------ */

const urgency_icons = {
    _1: "🟢",
    0: "❔",
    1: "🟡",
    2: "🟣",
    3: "NA",
    4: "🔴",
    5: "⚠️",
    12: "🟣",
    42: "🔴"
}

const urgecy_notes = {
    12: "+ 🟡 Paper low.",
    42: "+ 🟣 App problem."
}



/* Gather new emails. */
const getEmails = async () => {
    try {
        const imap = new Imap(imapConfig);

        imap.once('ready', async () => {
            await openAndReadInbox(imap);
            imap.end();
        });

        imap.once('error', (err) => {
            console.log(err);
        });

        imap.once('end', () => {
            console.log('Connection ended');
        });

        imap.connect();
    } catch (ex) {
        console.log('an error occurred');
    }
};

/* Read email form inbox. */
const openAndReadInbox = async (imap) => {
    const openBox = util.promisify(imap.openBox.bind(imap));
    const search = util.promisify(imap.search.bind(imap));
    const fetch = util.promisify(imap.fetch.bind(imap));

    const threeHoursAgo = new Date();
    threeHoursAgo.setHours(threeHoursAgo.getHours() - 1);

    console.log("Fetching from:",threeHoursAgo);

    try {
        await openBox('INBOX', false);
        const results = await search(['UNSEEN', ['SINCE', threeHoursAgo]]);
        const messages = imap.fetch(results, {bodies: ''});

        messages.on('message', message => {
            message.on('body', stream => {
                console.log("next message...")
                processEmail(stream);
            });

            message.once('attributes', attrs => {
                console.log("HEWWOO")
                const {uid} = attrs;
                console.log(uid)
                imap.addFlags(uid, ['\\Seen'], (err) => {
                    if (err) {
                        console.log('Error marking as read:', err);
                    } else {
                        console.log('Marked as read!');
                    }
                });
            });

            misc.last_check = new Date();
            fs.writeFileSync('../.website/storage/misc.json', JSON.stringify(misc, null, '\t'))
            fs.writeFileSync('./bin/status_database.json', JSON.stringify(status_database, null, '\t'))
        });

        //fs.writeFileSync('./bin/status_database.json', JSON.stringify(status_database, null, '\t'));
    } catch (ex) {
        return Promise.reject(ex);
    }
};

/* Process amails. */
const processEmail = async (stream) => {
    const parsed = await simpleParser(stream);
    console.log(parsed.subject)
    
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

    if (parsed.subject.toLowerCase().includes('kiosks')) {
        await analyseData_DEVICES_v2(emailData);
    }

    if (parsed.subject.toLowerCase().includes('apps')) {
        await analyseData_APPS(emailData);
    }
};

const markEmailAsRead = async (uid) => {
    const addFlags = util.promisify(imap.addFlags.bind(imap));
    await addFlags(uid, ['\\Seen']);
    console.log('Marked as read!');
};

const deleteEmail = async (uid) => {
    const addFlags = util.promisify(imap.addFlags.bind(imap));
    await addFlags(uid, ['\\Deleted']);
    const expunge = util.promisify(imap.expunge.bind(imap));
    await expunge();
    console.log('Email deleted!');
};



/* START. */
const load = async () => {
    await getEmails();
    console.log("----- SET FINISHED ------")
    fs.writeFileSync('./bin/status_database.json', JSON.stringify(status_database, null, '\t'));
}
load();
/* ------ */



/* Functions. */
const checkAccept = (data, indices) => {
    if (eval(config.misc_conditions.database_filter, data)) {return true}
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

    if (appUrgencyLevel > 0 && deviceUrgencyLevel > 0) {
        const outputLevel = `${deviceUrgencyLevel}${appUrgencyLevel}`;

        return {
            urgency_level: Number(outputLevel),
            icon: urgency_icons[outputLevel],
            note: urgecy_notes[outputLevel] || ""
        };
    } else {
        const outputLevel = deviceUrgencyLevel > 0 ? deviceUrgencyLevel : appUrgencyLevel;

        return {
            urgency_level: outputLevel,
            icon: urgency_icons[String(outputLevel).replace("-","_")],
            note: outputNote
        };
    }
}

const getStatusData = (data, urgencyLevel, indices) => {
    const connStatusCodes = status_messages.conn.codes;
    if (urgencyLevel === -1) {return {icon: connStatusCodes[2].icon, message: connStatusCodes[2].messages[Math.floor(Math.random() * connStatusCodes[2].messages.length)]};}
    if (urgencyLevel === 0) {return {icon: connStatusCodes[0].icon, message: connStatusCodes[0].messages[Math.floor(Math.random() * connStatusCodes[0].messages.length)]};}
    
    let dataKey, statusObject;
    for (let statusType in status_messages) {
        dataKey = indices[statusType+"_status"];

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
                    return location.name;
                }
            }
        }
    }

    return undefined;
}

const handleError = (logName, errorData) => {
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
    status_database[kioskName] = {
        id: kioskName,
        location: findLocation(kioskName) || ".undefined",
        urgency_level: -1,
        urgency_icon: "",
        note: "",
        devices: {},
        applications: {}
    }

    return status_database[kioskName];
}

const updateTimeline = (deviceObject) => {
    const timeValue = new Date(deviceObject.last_seen).toJSON();

    const insertData = [
        timeValue,
        deviceObject.device_name.split(/(\.|\d+)/)[0],
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
        deviceObject.urgency_level
    ]

    Database.run('INSERT INTO devicetimeline (time, type, device_name, kiosk_name, conn_status, comm_status, coupons_printed, execution_status, fault_status, paper_jams, mediabin1_status, last_seen, last_update, service_connection, target_status, status_message, urgency_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', insertData, function(err) {
        if (err) {
            console.log(err)
            handleError("Database INSERT", {Error_inserting_new_row: err.message})
        }
    });
}
/* ---------- */



/* Data Analyser. */
let dataRow, deviceName, deviceObject, kioskName, kioskObject, kioskUrgency, newUrgency, statusData;
const analyseData_DEVICES = async (data) => {
    const emailInfo = data.split("\n\n\n|\n")[0],
          dataTypes = data.split("\n\n\n|\n")[1].split("\n|\n")[0].split("\n"),
          dataArray = data.split("\n\n\n|\n")[1].split("\n|\n").slice(1),
          indices = {};

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

        try {
            // Names:
            kioskName = dataRow[indices.kiosk_name];
            deviceName = dataRow[indices.device_name].replace("."+kioskName,"");

            // Objects in database:
            kioskObject = status_database[kioskName] || newKiosk(kioskName);
            deviceObject = kioskObject.devices[deviceName] || newItem(kioskName, "devices", deviceName);

            // Set all properties:
            for (let key in indices) {
                deviceObject[key] = isNaN(dataRow[indices[key]]) ? dataRow[indices[key]] : Number(dataRow[indices[key]]);
            }

            // Set special properties:
            deviceObject.last_seen = createDateTimestamp(dataRow[indices.last_seen]) || createDateTimestamp(dataRow[indices.last_execution]);

            newUrgency = getUrgencyLevel(dataRow, deviceName.split(/\.|\d+/)[0], indices);
            if (newUrgency !== deviceObject.urgency_level) {deviceObject.last_update = deviceObject.last_seen};
            deviceObject.urgency_level = getUrgencyLevel(dataRow, deviceName.split(/\.|\d+/)[0], indices);

            statusData = getStatusData(dataRow, deviceObject.urgency_level, indices);
            deviceObject.status_message = statusData.message;
            deviceObject.status_indicator = statusData.icon;

            kioskUrgency = getKioskUrgencyData(kioskObject);
            kioskObject.location = findLocation(kioskName) || ".undefined";
            kioskObject.urgency_level = kioskUrgency.urgency_level;
            kioskObject.urgency_icon = kioskUrgency.icon;
            kioskObject.note = kioskUrgency.note;
        } catch (error) {}
    }
    /* --------------------------- */
}

const analyseData_DEVICES_v2 = async (data) => {
    const emailInfo = data.split("\n\n\n|\n")[0],
          dataTypes = data.split("\n\n\n|\n")[1].split("\n|\n")[0].split("\n"),
          dataArray = data.split("\n\n\n|\n")[1].split("\n|\n").slice(1),
          dataGroups = {},
          foundIndices = [];

    let subGroupName;
    for (let typeIndex in dataTypes) {
        if (dataTypes[typeIndex].includes("/")) {
            //for (let key in table_naming) {
                //if (dataTypes[typeIndex].toLowerCase().replaceAll(" ","_").includes(table_naming[key].toLowerCase().replaceAll(" ","_"))) {
                    subGroupName = dataTypes[typeIndex].replaceAll(" ","_").split("/")[1].split("_")[0];
                    if (!dataGroups[subGroupName]) {dataGroups[subGroupName] = {}};
                    dataGroups[subGroupName][dataTypes[typeIndex].toLowerCase().replaceAll(" ","_").split("/")[1].substring(dataTypes[typeIndex].replaceAll(" ","_").split("/")[1].indexOf('_')+1)] = typeIndex;
                    foundIndices.push(typeIndex);
                //}
            //}
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

            for (let dataRowIndex in dataArray) {
                dataRow = dataArray[dataRowIndex].replaceAll("\n","").split("/").slice(1);
                dataRow = dataRow.map(item => item = isNaN(Number(item)) ? item : Number(item));

                if (dataRow[indices.device_name] && dataRow[indices.device_name].includes(".") && checkAccept(dataRow, indices)) {
                    try {
                        // Names:
                        kioskName = dataRow[indices.kiosk_name];
                        deviceName = dataRow[indices.device_name].replace("."+kioskName,"");
                        console.log(dataRow[indices.device_name]);

                        // Objects in database:
                        kioskObject = status_database[kioskName] || newKiosk(kioskName);
                        deviceObject = kioskObject.devices[deviceName] || newItem(kioskName, "devices", deviceName);

                        // Set all properties:
                        for (let key in indices) {
                            deviceObject[key] = isNaN(dataRow[indices[key]]) ? dataRow[indices[key]] : Number(dataRow[indices[key]]);
                        }

                        // Set special properties:
                        deviceObject.last_seen = createDateTimestamp(dataRow[indices.last_seen]) || createDateTimestamp(dataRow[indices.last_execution]);

                        newUrgency = getUrgencyLevel(dataRow, deviceName.split(/\.|\d+/)[0], indices);
                        if (newUrgency !== deviceObject.urgency_level) {deviceObject.last_update = deviceObject.last_seen};
                        deviceObject.urgency_level = getUrgencyLevel(dataRow, deviceName.split(/\.|\d+/)[0], indices);

                        statusData = getStatusData(dataRow, deviceObject.urgency_level, indices);
                        deviceObject.status_message = statusData.message;
                        deviceObject.status_indicator = statusData.icon;

                        kioskUrgency = getKioskUrgencyData(kioskObject);
                        kioskObject.location = findLocation(kioskName) || ".undefined";
                        kioskObject.urgency_level = kioskUrgency.urgency_level;
                        kioskObject.urgency_icon = kioskUrgency.icon;
                        kioskObject.note = kioskUrgency.note;

                        updateTimeline(deviceObject);
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

                // Set special properties:
                appObject.display_name = config.applications[appCode] === "undefined" ? undefined : config.applications[appCode];
                appObject.app_status = Number(appStatus);
                appObject.urgency_level = statusObject.urgency_level;
                appObject.status_indicator = statusObject.icon;
                appObject.status_message = statusObject.messages[Math.floor(Math.random() * statusObject.messages.length)];
                appObject.last_seen = lastSeen;
            }
        }

        // Set special properties:
        kioskUrgency = getKioskUrgencyData(kioskObject);
        kioskObject.location = findLocation(kioskName) || ".undefined";
        kioskObject.urgency_level = kioskUrgency.urgency_level;
        kioskObject.urgency_icon = kioskUrgency.icon;
        kioskObject.note = kioskUrgency.note;
    }
    /* --------------------------- */
}
/* --------------- */