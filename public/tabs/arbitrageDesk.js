(function () {
  const registry = window.QGagarinDashboardTabs || {
    definitions: [],
    byId: {},
    register(definition) {
      this.byId[definition.id] = definition;
      this.definitions = this.definitions.filter((item) => item.id !== definition.id).concat(definition);
    },
    all() {
      return this.definitions.slice();
    },
  };

  window.QGagarinDashboardTabs = registry;
  registry.register({
    id: "arbitrage",
    label: "Arbitrage Desk",
    panelId: "tab-arbitrage",
    requiredElements: ["chart", "detailBody", "groupFilters"],
    clickOnlyDetail: true,
    profitableColorToken: "profit",
  });
})();
