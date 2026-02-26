import { View, Text, StyleSheet } from 'react-native';

export default function ManagerScreen() {
    return (
        <View style={styles.container}>
            <Text style={styles.text}>Manager Dashboard syncing with new Next.js API coming soon.</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
    text: { fontSize: 18, textAlign: 'center', color: '#666' }
});
