'use strict';

const ZenKitClient = require('./api/zenKit.js');
const config = require('./config.js');

/**
 * Defines sync list client class
 */
class SyncListClient {
  constructor(householdListManager, key = '', syncedLists = []) {
    this.zenKitClient = new ZenKitClient(
      config.ZENKIT_API_URL, key);
    this.householdListManager = householdListManager;
    this.syncedLists = syncedLists;
  }

  /**
   * Get mapped key
   * @return {Promise}
   */
  mapAlexaToZenkitLists(listName, zlists, reverse = false) {
    if (reverse) {
      // Take a zenkit list name and map it to the right Alexa list name
      if (listName === config.ZENKIT_SHOPPING_LIST) {
        return config.ALEXA_SHOPPING_LIST;
      } else if (listName.toLowerCase().includes(config.ZENKIT_TODO_LIST)) {
        return config.ALEXA_TODO_LIST
      } else if (listName === config.ZENKIT_INBOX_LIST) {
        for (var k in zlists) {
          if (k.toLowerCase().includes(config.ZENKIT_TODO_LIST)) { return ''; }
        }
        return config.ALEXA_TODO_LIST
      } else {
        return listName
      }
    } else {
      if (listName === config.ALEXA_SHOPPING_LIST) {
        return config.ZENKIT_SHOPPING_LIST;
      } else if (listName === config.ALEXA_TODO_LIST) {
        for (var k in zlists) {
          if (k.toLowerCase().includes(config.ZENKIT_TODO_LIST)) { return k; }
        }
        return config.ZENKIT_INBOX_LIST
      } else {
        return listName
      }
    }
  }
  /**
   * Get Alexa shopping list
   * @return {Promise}
   */
  async getAlexaLists() {
    // Get all lists
    const { lists } = await this.householdListManager.getListsMetadata();
    var res = {};
    lists.forEach(async (list) => {
      if (list.state === 'active') {
        const [active, completed] = await Promise.all([
          this.householdListManager.getList(list.listId, 'active'),
          this.householdListManager.getList(list.listId, 'completed')
        ]);
        res[list.name] = {listId: list.listId};
        res[list.name].listName = list.name;
        res[list.name].items = [].concat(active.items, completed.items);
      };
    });
    return res;
  }

  /**
   * Get zenkit lists
   * @return {Promise}
   */
  async getZenkitLists() {
    // Get lists
    var zlists = await this.zenKitClient.getLists();
    const elements = {};
    for (const [key, value] of Object.entries(zlists)) {
      elements[key] =  this.zenKitClient.getElements(value.shortId);
    }
    // Parse list paramaters
    for (const [key, value] of Object.entries(zlists)) {
      const element =  JSON.parse(await elements[key]);
      zlists[key].titleUuid = element.find(list => list.name ===  'Title').uuid;
      zlists[key].uncompleteId = element.find(list => list.name ===  'Stage')
        .elementData
        .predefinedCategories
        .find(list => list.name ===  'To-Do')
        .id;
      zlists[key].completeId = element.find(list => list.name ===  'Stage')
        .elementData
        .predefinedCategories
        .find(list => list.name ===  'Done')
        .id;
      zlists[key].stageUuid = element.find(list => list.name ===  'Stage').uuid;
    }
    return zlists;
  }

  /**
   * Get zenkit lists
   * @return {Promise}
   */
  async createZenkitLists(zlists, alists) {
    var flag = false;
    var workspace = '';
    const promises = [];
    //create zlist from alist if zlist doesn't exist
    for (const [key, value] of Object.entries(alists)) {
      const newKey = this.mapAlexaToZenkitLists(key, zlists);
      if (!(newKey in zlists)) {
        flag = true;
        console.log('Creating list: ' + newKey);
        workspace = workspace === '' ? await this.zenKitClient.getWorkspace() : workspace;
        promises.push(this.zenKitClient.createList(newKey, workspace.id));
      }
    };
    if (flag) {
      await Promise.all(promises);
      return this.getZenkitLists()
    } else {
      return zlists
    };
  }
  /**
   * Update Alexa list
   * @return {Promise}
   */
  async updateAlexaList(newUser = false) {
    const [alexaLists, zenkitListTemp] = await Promise.all([
      this.getAlexaLists(), this.getZenkitLists()]);
    const zenkitLists = await this.createZenkitLists(zenkitListTemp, alexaLists);
    const zenkitListItemsArr = {};
    // Define get item properties function
    const getItemProperties = (alexaItem, zenkitItem) => ({
      alexaId: alexaItem.id,
      zenKitUuidId: zenkitItem.uuid,
      zenKitEntryId: zenkitItem.id,
      status: alexaItem.status,
      updatedTime: new Date(alexaItem.updatedTime).toISOString(),
      value: alexaItem.value.toLowerCase(),
      version: alexaItem.version
    });
    for (const [key, zenkitList] of Object.entries(zenkitLists)) {
      zenkitListItemsArr[zenkitList.id] = this.zenKitClient.getListItems(zenkitList.id, zenkitList.stageUuid);
    }
    for (const [key, zenkitList] of Object.entries(zenkitLists)) {
      const promises = [];
      const mappedKey = this.mapAlexaToZenkitLists(key, zenkitLists, true);
      if (!(mappedKey)) { continue; }
      const alexaList = alexaLists[mappedKey];
      if (!(alexaList)) { continue; }
      const zenkitListItems = await zenkitListItemsArr[zenkitList.id];
      zenkitListItems.forEach((zenkitItem) => {
        // Find alexa matching item
        const alexaItem = alexaList.items.find(alexaItem =>
          alexaItem.value.toLowerCase() === zenkitItem.displayString.toLowerCase());
        // Determine alexa status based of Zenkit crossed off property
        const zenkitItemStatus = !zenkitItem.completed ? 'active' : 'completed';
        if (typeof alexaItem !== 'undefined') {
          // Set alexa item to be updated if crossed off status not synced, otherwise leave untouched
          promises.push(zenkitItemStatus === alexaItem.status ? getItemProperties(alexaItem, zenkitItem) :
            this.householdListManager.updateListItem(alexaList.listId, alexaItem.id, {
              value: alexaItem.value, status: zenkitItemStatus, version: alexaItem.version}
            ).then((item) => getItemProperties(item, zenkitItem))
          );
        } else {
          // Set alexa item to be created
          promises.push(
            this.householdListManager.createListItem(alexaList.listId, {
              value: zenkitItem.displayString.toLowerCase(), status: zenkitItemStatus}
            ).then((item) => getItemProperties(item, zenkitItem))
          );
        }
      });

      // Determine Alexa items not present in zenkit list - if it's a new user then add them to zenkit if it's an existing user, then delete them.
      if (newUser) {
        alexaList.items
          .filter(alexaItem =>
            zenkitListItems.every(zenkitItem =>
              zenkitItem.displayString.toLowerCase() !== alexaItem.value.toLowerCase()))
          .forEach(alexaItem =>
            promises.push(
              this.zenKitClient.addItem(
                zenkitList.id, zenkitList.titleUuid, alexaItem.value.toLowerCase())
              .then(zenkitItem => getItemProperties(alexaItem, zenkitItem))
            )
          );
      } else {
        alexaList.items
          .filter(alexaItem =>
            zenkitListItems.every(zenkitItem =>
              zenkitItem.displayString.toLowerCase() !== alexaItem.value.toLowerCase()))
          .forEach(alexaItem =>
            promises.push(
              this.householdListManager.deleteListItem(alexaList.listId, alexaItem.id)));
      }
      // put all the synced items into the synced lists
      const syncedItems = await Promise.all(promises);
      const syncedList = {
        alexaId: alexaList.listId,
        alexaListName: mappedKey,
        zenkitListName: key,
        items: syncedItems.filter(Boolean),
        listId: zenkitList.id,
        shortListId: zenkitList.shortId,
        titleUuid: zenkitList.titleUuid,
        uncompleteId: zenkitList.uncompleteId,
        completeId: zenkitList.completeId,
        stageUuid: zenkitList.stageUuid,
        workspaceId: zenkitList.workspaceId
      };
      this.syncedLists.push(syncedList);
    }
    //Return synced items promise result
    return this.syncedLists
  }

  /**
   * Update zenKit list
   * @param  {Object}  request
   * @return {Promise}
   */
  async updateZenkitList(request) {
    var syncedList = this.syncedLists.find((syncedList) => syncedList.alexaId === request.listId);
    if (!(syncedList)) {
      const list = await this.householdListManager.getList(request.listId, 'active');
      console.log('Creating new list: ' + list.name);
      const zenkitList = await this.zenKitClient.createList(list.name, this.syncedLists[0].workspaceId);
      const element = JSON.parse(await this.zenKitClient.getElements(zenkitList.shortId));
      this.syncedLists.push({
        alexaId: request.listId,
        alexaListName: list.name,
        zenkitListName: list.name,
        items: [],
        listId: zenkitList.id,
        shortListId: zenkitList.shortId,
        titleUuid: element.find(list => list.name ===  'Title').uuid,
        uncompleteId: element.find(list => list.name ===  'Stage')
          .elementData
          .predefinedCategories
          .find(list => list.name ===  'To-Do')
          .id,
        completeId: element.find(list => list.name ===  'Stage')
          .elementData
          .predefinedCategories
          .find(list => list.name ===  'Done')
          .id,
        stageUuid: element.find(list => list.name ===  'Stage').uuid,
        workspaceId: zenkitList.workspaceId
      })
      syncedList = this.syncedLists.find((syncedList) => syncedList.alexaId === request.listId);
    }
    const syncedItems = syncedList.items;
    const promises = [];
    // Get alexa items data based on request item ids if not delete request, otherwise use id only
    const alexaItems = await Promise.all(
      request.listItemIds.map(itemId => request.type === 'ItemsDeleted' ? {id: itemId} :
        this.householdListManager.getListItem(request.listId, itemId)));
    alexaItems.forEach((alexaItem) => {
      if (request.type === 'ItemsCreated') {
        // Determine synced item with alexa item value
        const syncedItem = syncedItems.find(item =>
          item.value.toLowerCase() === alexaItem.value.toLowerCase()
          || item.alexaId === alexaItem.id);
        if (!syncedItem) {
          promises.push(
            // Set zenKit item to be added
            this.zenKitClient.addItem(
              syncedList.listId, syncedList.titleUuid, alexaItem.value.toLowerCase()
            ).then(function (res) {
              // Add new synced item
              syncedItems.push({
                zenKitUuidId: res.uuid,
                zenKitEntryId: res.id,
                alexaId: alexaItem.id,
                status: alexaItem.status,
                updatedTime: new Date(alexaItem.updatedTime).toISOString(),
                value: alexaItem.value.toLowerCase(),
                version: alexaItem.version
              });
            })
          );
        }
      } else if (request.type === 'ItemsUpdated') {
        // Determine synced item with alexa item id
        const syncedItem = syncedItems.find(item => item.alexaId === alexaItem.id);
        if (syncedItem) {
          // Update existing item only if updated time on synced item is lower than alexa item
          if (new Date(syncedItem.updatedTime).getTime() < new Date(alexaItem.updatedTime).getTime()) {
            const value = alexaItem.value.toLowerCase();
            // Set zenkit item to be renamed if alexa value different than synced item
            if (syncedItem.value !== value) {
              promises.push(
              this.zenKitClient.updateItemTitle(
                syncedList.listId, syncedItem.zenKitEntryId,
                syncedList.titleUuid, alexaItem.value.toLowerCase())
              );
            }
            // Set zenkit item crossed status to be updated if different
            if (syncedItem.status !== alexaItem.status) {
              promises.push(
                this.zenKitClient.updateItemStatus(
                  syncedList.listId, syncedItem.zenKitEntryId, syncedList.stageUuid,
                  alexaItem.status === 'completed' ? syncedList.completeId : syncedList.uncompleteId)
              );
            }
            // Update synced item
            Object.assign(syncedItem, {
              status: alexaItem.status,
              updatedTime: new Date(alexaItem.updatedTime).toISOString(),
              value: alexaItem.value.toLowerCase(),
              version: alexaItem.version
            });
          }
        } else {
          // Set alexa updated item to be deleted
          promises.push(
            this.householdListManager.deleteListItem(
              syncedList.alexaId, alexaItem.id));
        }
      } else if (request.type === 'ItemsDeleted') {
        // Determine synced item index with alexa item id
        const index = syncedItems.findIndex(item => item.alexaId === alexaItem.id);
        // Set Zenkit item to be deleted if found
        if (index > -1) {
          promises.push(
            this.zenKitClient.deleteItem(
              syncedList.listId, syncedItems[index].zenKitUuidId));
          // Remove deleted synced item
          syncedItems.splice(index, 1);
        }
      }
    });

    // Apply all changes
    await Promise.all(promises);
    // Return synced list
    const index = this.syncedLists.findIndex((syncedList) => syncedList.alexaId === request.listId);
    this.syncedLists[index] = syncedList;
    return this.syncedLists;
  }

  /**
   * Create to-do list item letting the customer know that the account sync failed
   * @return {Promise}
   */
  async createSyncToDo() {
    const listEntryName = 'Zenkit Alexa Sync is not setup correctly! Go to https://www.amazon.com/dp/B087C8XQ3T and click on "Link Account"'
    // Get all lists
    const { lists } = await this.householdListManager.getListsMetadata();
    const listId = lists.find(item => item.name === 'Alexa to-do list')
        .listId;
    const listItems = await this.householdListManager.getList(listId, 'active');
    if (listItems.items.find(item => item.value === listEntryName)) {
      return 'Sync item already present'
    } else {
      return this.householdListManager.createListItem(
        listId, {
        value: listEntryName , status: 'active'}
      );
    };
  }
}

module.exports = SyncListClient;
