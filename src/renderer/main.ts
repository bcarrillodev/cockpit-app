import { createApp } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import Aura from "@primeuix/themes/aura";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import Drawer from "primevue/drawer";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import Select from "primevue/select";
import Tag from "primevue/tag";
import Textarea from "primevue/textarea";
import App from "./App.vue";
import "./styles.css";
import "primeicons/primeicons.css";

const app = createApp(App);

app.use(createPinia());
app.use(PrimeVue, {
  ripple: true,
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: ".cockpit-theme-dark"
    }
  }
});

app.component("PButton", Button);
app.component("PDialog", Dialog);
app.component("PDrawer", Drawer);
app.component("PInputText", InputText);
app.component("PMessage", Message);
app.component("PSelect", Select);
app.component("PTag", Tag);
app.component("PTextarea", Textarea);

app.mount("#app");
