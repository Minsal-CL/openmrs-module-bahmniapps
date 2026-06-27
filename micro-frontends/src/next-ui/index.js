import {React2AngularBridgeBuilder} from "../utils/bridge-builder";
import {AllOrdersDashboard} from "./Containers/AllOrders/AllOrdersDashboard";
import {PatientAlergiesControl} from "./Containers/patientAlergies/PatientAlergiesControl";
import {FormDisplayControl} from "./Containers/formDisplayControl/FormDisplayControl";
import {ProviderNotifications} from "./Containers/providerNotifications/ProviderNotifications";
import {OtNotesSavePopup, OtNotesDeletePopup} from "./Containers/otNotes/OtNotes";
import {VacunasDisplayControl} from "./Containers/vacunasDisplayControl/VacunasDisplayControl";
import {IpsDisplayControl} from "./Containers/ips/ipsDisplayControl";
import {IpsIcvpDisplayControl} from "./Containers/ipsIcvp/ipsICVPDisplayControl";
import {ServiceRequestDisplayControl} from "./Containers/serviceRequestDash/serviceRequestDisplayControl";
import {MedicationStatementDisplayControl} from "./Containers/medicationStatementDash/medicationStatementDisplayControl";
import {LaboratoryOrdersControl} from "./Containers/LaboratoryOrders/LaboratoryOrdersControl";
import {MedicationOrdersControl} from "./Containers/MedicationOrders/MedicationOrdersControl";
import {ImagingOrdersControl} from "./Containers/ImagingOrders/ImagingOrdersControl";
import {ProcedureOrdersControl} from "./Containers/ProcedureOrders/ProcedureOrdersControl";
import {ReferralOrdersControl} from "./Containers/ReferralOrders/ReferralOrdersControl";
import {CertificatesControl} from "./Containers/Certificates/CertificatesControl";

const MODULE_NAME = "bahmni.mfe.nextUi";

angular.module(MODULE_NAME, []);

const builder = new React2AngularBridgeBuilder({
    moduleName: MODULE_NAME,
    componentPrefix: "mfeNextUi",
});

builder.createComponentWithTranslationForwarding(
    "PatientAlergiesControl",
    PatientAlergiesControl
);

builder.createComponentWithTranslationForwarding(
    "FormDisplayControl",
    FormDisplayControl
);

builder.createComponentWithTranslationForwarding(
    "ProviderNotifications",
    ProviderNotifications
);

builder.createComponentWithTranslationForwarding(
    "OtNotesSavePopup",
    OtNotesSavePopup
);

builder.createComponentWithTranslationForwarding(
    "OtNotesDeletePopup",
    OtNotesDeletePopup
);

builder.createComponentWithTranslationForwarding(
    "VacunasDisplayControl",
    VacunasDisplayControl
);

builder.createComponentWithTranslationForwarding(
    "IpsDisplayControl",
    IpsDisplayControl
);

builder.createComponentWithTranslationForwarding(
    "IpsIcvpDisplayControl",
    IpsIcvpDisplayControl
);

builder.createComponentWithTranslationForwarding(
    "ServiceRequestDisplayControl",
    ServiceRequestDisplayControl
);

builder.createComponentWithTranslationForwarding(
    "MedicationStatementDisplayControl",
    MedicationStatementDisplayControl
);

builder.createComponentWithTranslationForwarding(
    "LaboratoryOrdersControl",
    LaboratoryOrdersControl
);

builder.createComponentWithTranslationForwarding(
    "MedicationOrdersControl",
    MedicationOrdersControl
);

builder.createComponentWithTranslationForwarding(
    "ImagingOrdersControl",
    ImagingOrdersControl
);

builder.createComponentWithTranslationForwarding(
    "ProcedureOrdersControl",
    ProcedureOrdersControl
);

builder.createComponentWithTranslationForwarding(
    "ReferralOrdersControl",
    ReferralOrdersControl
);

builder.createComponentWithTranslationForwarding(
    "CertificatesControl",
    CertificatesControl
);

builder.createComponentWithTranslationForwarding(
    "AllOrdersDashboard",
    AllOrdersDashboard
);
